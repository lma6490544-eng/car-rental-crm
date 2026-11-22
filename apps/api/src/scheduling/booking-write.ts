import type { PoolClient } from 'pg';
import type { PricingQuoteRow } from '../pricing/pricing.types';
import { AuthRequest, audit, fail } from '../platform/security';
import { ruleSets } from '../pricing/rules';
import { isDeepStrictEqual } from 'node:util';
import { previewBooking } from './booking-pricing';
import { SchedulingService } from './scheduling.service';
import type { BookingTermsInput } from './booking.dto';
type CustomerRow = {
  id: number;
  version: number;
  type: string;
  display_name: string;
  phone: string;
  email: string;
  inn: string;
  is_blocked: boolean;
  details: Record<string, string>;
};

export type BookingRow = {
  id: number;
  customer_id: number;
  status: string;
  version: number;
  start_at: Date;
  end_at: Date;
  target_type: string;
  target_vehicle_id: number | null;
  target_model_id: number | null;
  target_brand_id: number | null;
  target_group_id: number | null;
  created_by: number;
  created_at: Date;
  updated_at: Date;
};

// Shared by creation and the existing terms-edit command; never opens a transaction.
export async function lockBookingCustomer(
  c: PoolClient,
  input: BookingTermsInput,
  customerId: number | undefined,
  creating: boolean,
) {
  let lockedCustomer: CustomerRow | undefined;
  if (customerId) {
    const customer = (
      await c.query<CustomerRow>('SELECT * FROM customers WHERE id=$1 FOR UPDATE', [customerId])
    ).rows[0];
    lockedCustomer = customer;
    if (!customer) fail(404, 'NOT_FOUND', 'Клиент не найден.');
    if (creating && customer.is_blocked)
      fail(422, 'CUSTOMER_BLOCKED', 'Новые брони заблокированному клиенту запрещены.');
  }
  if (
    input.customer &&
    'existingId' in input.customer &&
    input.customer.data &&
    lockedCustomer!.version !== input.customer.expectedVersion
  )
    fail(
      409,
      'CUSTOMER_VERSION_CONFLICT',
      'Карточка клиента изменена другим сотрудником. Перечитайте клиента; ваш ввод сохранён.',
      { currentVersion: lockedCustomer!.version },
    );

  return lockedCustomer;
}
export async function assignedVehicleModel(
  c: PoolClient,
  vehicleId: number,
  models: number[],
  lock = false,
) {
  const vehicle = (
    await c.query<{ model_id: number; archived_at: Date | null }>(
      'SELECT model_id,archived_at FROM vehicles WHERE id=$1' + (lock ? ' FOR SHARE' : ''),
      [vehicleId],
    )
  ).rows[0];
  if (!vehicle || vehicle.archived_at || !models.includes(vehicle.model_id))
    fail(422, 'VEHICLE_NOT_ELIGIBLE', 'Машина не входит в допустимый набор.');
  return vehicle.model_id;
}

export async function prepareBookingTerms(
  c: PoolClient,
  s: SchedulingService,
  input: BookingTermsInput,
  r: AuthRequest,
  models: number[],
  customerId: number | undefined,
  lockedCustomer: CustomerRow | undefined,
  bookingId?: number,
) {
  if (!!input.quoteId === !!input.pricing)
    fail(400, 'VALIDATION_ERROR', 'Передайте условия или исходный расчёт.');
  const vehicleId = input.target.type === 'vehicle' ? input.target.id : input.vehicleId;
  const assignedModel = vehicleId
    ? await assignedVehicleModel(c, vehicleId, models, true)
    : undefined;
  let quote: PricingQuoteRow | undefined;
  if (input.pricing) {
    const preview = await previewBooking(
      c,
      input.target,
      input.pricing,
      models,
      r.auth!.user.id,
      assignedModel,
    );
    if (preview.previewToken !== input.previewToken)
      fail(409, 'QUOTE_STALE', 'Условия или тариф изменились. Дождитесь нового расчёта.');
    if (
      JSON.stringify([...preview.calculation.overridesToConfirm].sort()) !==
      JSON.stringify([...new Set(input.confirmedOverrides ?? [])].sort())
    )
      fail(
        422,
        'OVERRIDES_CONFIRMATION_REQUIRED',
        'Подтвердите ручные условия в разделе «Лояльность».',
      );
    quote = (
      await c.query<PricingQuoteRow>(
        `INSERT INTO pricing_quotes(created_by,confirmed_by,expires_at,confirmed_at,version,input,snapshot,confirmed_overrides) VALUES ($1,$1,now()+interval '30 minutes',now(),2,$2,$3,$4) RETURNING *`,
        [
          r.auth!.user.id,
          JSON.stringify(preview.input),
          JSON.stringify(preview.calculation),
          JSON.stringify(input.confirmedOverrides ?? []),
        ],
      )
    ).rows[0];
    await audit(c, r.auth!.user.id, 'pricing_quote', 'pricing.confirmed', quote.id, r.requestId, {
      context: 'booking',
      confirmedOverrides: input.confirmedOverrides ?? [],
    });
    await c.query('INSERT INTO outbox_jobs(business_key,kind,payload) VALUES ($1,$2,$3)', [
      'pricing.confirmed:' + quote.id,
      'pricing.confirmed',
      JSON.stringify({ id: quote.id, version: 2 }),
    ]);
  } else
    quote = (
      await c.query<PricingQuoteRow>('SELECT * FROM pricing_quotes WHERE id=$1 FOR SHARE', [
        input.quoteId,
      ])
    ).rows[0];
  if (!quote?.confirmed_at || quote.snapshot.operationKind !== 'initial')
    fail(
      422,
      'CONFIRMED_QUOTE_REQUIRED',
      'Выберите подтверждённый первичный расчёт условий брони.',
    );
  const snapshot = quote.snapshot;
  if (snapshot.ruleVersion !== ruleSets.at(-1)!.version)
    fail(409, 'QUOTE_STALE', 'Для новых условий нужен расчёт текущего прайса.');
  const startAt = snapshot.startAt,
    endAt = new Date(Date.parse(startAt) + snapshot.contractDays * 86400000).toISOString();
  const modelGroups = (
    await c.query('SELECT DISTINCT pricing_group_id FROM vehicle_models WHERE id=ANY($1::int[])', [
      models,
    ])
  ).rows.map((x) => x.pricing_group_id);
  if (
    !snapshot.overrides?.customDailyRateRub &&
    !modelGroups.includes(snapshot.periods[0].pricingGroup.id)
  )
    fail(
      422,
      'TARIFF_TARGET_MISMATCH',
      'Тарифная группа не соответствует выбранным моделям. Согласуйте собственную цену с причиной.',
    );
  if (quote.input.usages?.length || quote.input.wash || quote.input.surchargeOverride)
    fail(
      422,
      'BOOKING_QUOTE_INVALID',
      'Условия брони не должны содержать фактический возврат и доплаты.',
    );
  if (vehicleId) await s.assertAssignable(c, vehicleId, startAt, endAt, bookingId);
  const result = await s.evaluate(c, {
    id: bookingId,
    target: input.target,
    models,
    startAt,
    endAt,
    vehicleId,
  });
  s.accept(result, input.riskAcceptance);
  const customerData = input.customer
    ? 'new' in input.customer
      ? input.customer.new
      : input.customer.data
    : undefined;
  if (input.pricing && customerData) {
    if (!customerData.phone) fail(422, 'CUSTOMER_PHONE_REQUIRED', 'Укажите телефон клиента.');
    if (
      customerData.type === 'individual' &&
      (!customerData.details.firstName || !customerData.details.lastName)
    )
      fail(422, 'CUSTOMER_NAME_REQUIRED', 'Укажите фамилию и имя клиента.');
  }
  if (customerId && customerData) {
    if (lockedCustomer!.type !== customerData.type)
      fail(422, 'CUSTOMER_TYPE_FIXED', 'Тип существующего клиента не меняется.');
    const data = customerData;
    if (
      !isDeepStrictEqual(
        [
          lockedCustomer!.display_name,
          lockedCustomer!.phone,
          lockedCustomer!.email,
          lockedCustomer!.inn,
          lockedCustomer!.details,
        ],
        [data.displayName, data.phone, data.email, data.inn, data.details],
      )
    ) {
      await c.query(
        'UPDATE customers SET display_name=$2,phone=$3,email=$4,inn=$5,details=$6,version=version+1,updated_at=now() WHERE id=$1',
        [
          customerId,
          data.displayName,
          data.phone,
          data.email,
          data.inn,
          JSON.stringify(data.details),
        ],
      );
      await audit(c, r.auth!.user.id, 'customer', 'customers.updated', customerId, r.requestId, {
        context: 'booking',
        fields: ['displayName', 'phone', 'email', 'inn', 'details'],
      });
      await c.query('INSERT INTO outbox_jobs(business_key,kind,payload) VALUES ($1,$2,$3)', [
        'customers.updated:' + customerId + ':' + (lockedCustomer!.version + 1),
        'customers.updated',
        JSON.stringify({ id: customerId, version: lockedCustomer!.version + 1 }),
      ]);
    }
  }
  if (!customerId && input.customer && 'new' in input.customer) {
    const data = input.customer.new;
    customerId = (
      await c.query<{ id: number }>(
        'INSERT INTO customers(type,display_name,phone,email,inn,details) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
        [
          data.type,
          data.displayName,
          data.phone,
          data.email,
          data.inn,
          JSON.stringify(data.details),
        ],
      )
    ).rows[0].id;
    await audit(c, r.auth!.user.id, 'customer', 'customers.created', customerId, r.requestId, {
      type: input.customer.new.type,
    });
    await c.query('INSERT INTO outbox_jobs(business_key,kind,payload) VALUES ($1,$2,$3)', [
      'customers.created:' + customerId + ':1',
      'customers.created',
      JSON.stringify({ id: customerId, version: 1 }),
    ]);
  }

  return { customerId, quote, snapshot, startAt, endAt, result, vehicleId };
}
export async function recordBookingTerms(
  c: PoolClient,
  s: SchedulingService,
  input: BookingTermsInput,
  r: AuthRequest,
  models: number[],
  row: { id: number; version: number },
  prepared: Awaited<ReturnType<typeof prepareBookingTerms>>,
  action: 'bookings.created' | 'bookings.terms',
) {
  const { quote, snapshot, startAt, endAt, result, vehicleId } = prepared;
  await c.query('DELETE FROM booking_eligible_models WHERE booking_id=$1', [row.id]);
  for (const model of models)
    await c.query('INSERT INTO booking_eligible_models(booking_id,model_id) VALUES ($1,$2)', [
      row.id,
      model,
    ]);
  await c.query(
    'UPDATE schedule_blocks SET retired_at=now() WHERE booking_id=$1 AND retired_at IS NULL',
    [row.id],
  );
  if (vehicleId)
    await s.assignment(c, row.id, vehicleId, startAt, endAt, r.auth!.user.id, input.reason);
  await c.query(
    'INSERT INTO booking_terms(booking_id,revision,quote_id,snapshot,reason,created_by) VALUES ($1,$2,$3,$4,$5,$6)',
    [
      row.id,
      row.version,
      quote.id,
      JSON.stringify({ ...snapshot, eligibleModels: models, target: input.target }),
      input.reason,
      r.auth!.user.id,
    ],
  );
  if (result.status !== 'feasible')
    await c.query(
      'INSERT INTO booking_risks(booking_id,snapshot,reason,created_by) VALUES ($1,$2,$3,$4)',
      [row.id, JSON.stringify(result), input.riskAcceptance!.reason, r.auth!.user.id],
    );
  await s.event(c, r, 'booking', row.id, row.version, action, {
    reason: input.reason,
    quoteId: quote.id,
    ...(result.status !== 'feasible'
      ? {
          availabilityStatus: result.status,
          availabilityComment: input.riskAcceptance?.reason,
        }
      : {}),
  });
}
