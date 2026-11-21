import type { PoolClient } from 'pg';
import type { z } from 'zod';
import type { Calculation } from '../pricing/calculate';
import { bookingPricing, previewBooking } from './booking-pricing';
import { Injectable } from '@nestjs/common';
import { AuthRequest, audit, fail } from '../platform/security';
import { SchedulingService, scheduleLock } from './scheduling.service';
import type { Target } from './scheduling.service';
import type {
  PreviewBookingInput,
  AssignVehicleInput,
  CancelBookingInput,
  MovePreviewInput,
  MoveBookingInput,
  CreateBookingInput,
  UpdateBookingInput,
} from './booking.dto';
import { lockBookingCustomer, prepareBookingTerms, recordBookingTerms } from './booking-write';
import type { BookingRow } from './booking-write';

type MoveBookingRow = Omit<BookingRow, 'target_type'> & {
  target_type: Target['type'];
  vehicle_id: number | null;
  snapshot: Calculation;
};
type MoveVehicleRow = {
  id: number;
  model_id: number;
  plate: string;
  is_ready: boolean;
  archived_at: Date | null;
  pricing_group_id: number;
};

@Injectable()
export class BookingService {
  constructor(private readonly s: SchedulingService) {}
  preview(input: PreviewBookingInput, request: AuthRequest) {
    return this.s.db.transaction(async (c) => {
      await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const old = input.bookingId
        ? (await c.query<BookingRow>('SELECT * FROM bookings WHERE id=$1', [input.bookingId]))
            .rows[0]
        : undefined;
      if (input.bookingId && !old) fail(404, 'NOT_FOUND', 'Бронь не найдена.');
      const same =
        old &&
        old.target_type === input.target.type &&
        (old.target_vehicle_id ??
          old.target_model_id ??
          old.target_brand_id ??
          old.target_group_id) === input.target.id;
      const models = same
        ? (
            await c.query<{ model_id: number }>(
              'SELECT model_id FROM booking_eligible_models WHERE booking_id=$1 ORDER BY model_id',
              [old.id],
            )
          ).rows.map((x) => x.model_id)
        : await this.s.models(c, input.target);
      const preview = await previewBooking(
        c,
        input.target,
        input.pricing,
        models,
        request.auth!.user.id,
      );
      const inspection = await this.s.inspect(c, {
        id: input.bookingId,
        target: input.target,
        models,
        startAt: preview.calculation.startAt,
        endAt: preview.calculation.agreedReturnAt,
        vehicleId: input.target.type === 'vehicle' ? input.target.id : null,
      });
      return { ...preview, ...inspection };
    });
  }
  cancel(input: CancelBookingInput, r: AuthRequest, bookingId: number) {
    return this.s.commands.run(
      r,
      'bookings.cancel',
      { bookingId, ...input },
      async (c) => {
        await scheduleLock(c);
        const row = (
          await c.query<BookingRow>(
            "UPDATE bookings SET status='cancelled',version=version+1,updated_at=now() WHERE id=$1 AND version=$2 AND status='confirmed' RETURNING *",
            [bookingId, input.expectedVersion],
          )
        ).rows[0];
        if (!row) fail(409, 'BOOKING_VERSION_CONFLICT', 'Бронь изменилась или уже отменена.');
        await c.query(
          'UPDATE schedule_blocks SET retired_at=now() WHERE booking_id=$1 AND retired_at IS NULL',
          [bookingId],
        );
        await this.s.event(c, r, 'booking', bookingId, row.version, 'bookings.cancelled', {
          reason: input.reason,
        });
        return row;
      },
      false,
    );
  }
  create(input: CreateBookingInput, r: AuthRequest) {
    return this.s.commands.run(
      r,
      'bookings.create',
      { bookingId: undefined, ...input },
      async (c) => {
        await scheduleLock(c);
        const customerId = 'existingId' in input.customer ? input.customer.existingId : undefined;
        const lockedCustomer = await lockBookingCustomer(c, input, customerId, true);
        const models = await this.s.models(c, input.target);
        const prepared = await prepareBookingTerms(
          c,
          this.s,
          input,
          r,
          models,
          customerId,
          lockedCustomer,
        );
        const { startAt, endAt } = prepared;
        const targets = ['vehicle', 'model', 'brand', 'equivalence_group'].map((t) =>
          input.target.type === t ? input.target.id : null,
        );
        const row = (
          await c.query<BookingRow>(
            'INSERT INTO bookings(customer_id,start_at,end_at,target_type,target_vehicle_id,target_model_id,target_brand_id,target_group_id,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
            [prepared.customerId, startAt, endAt, input.target.type, ...targets, r.auth!.user.id],
          )
        ).rows[0];
        await recordBookingTerms(c, this.s, input, r, models, row, prepared, 'bookings.created');
        return row;
      },
      false,
    );
  }
  update(input: UpdateBookingInput, r: AuthRequest, bookingId: number) {
    return this.s.commands.run(
      r,
      'bookings.terms',
      { bookingId, ...input },
      async (c) => {
        await scheduleLock(c);
        const old = bookingId
          ? (
              await c.query<BookingRow>('SELECT * FROM bookings WHERE id=$1 FOR UPDATE', [
                bookingId,
              ])
            ).rows[0]
          : undefined;
        if (
          bookingId &&
          (!old ||
            old.version !== ('expectedVersion' in input ? input.expectedVersion : 0) ||
            old.status !== 'confirmed')
        )
          fail(409, 'BOOKING_VERSION_CONFLICT', 'Перечитайте актуальную бронь.');
        const customerId =
          old?.customer_id ??
          (input.customer && 'existingId' in input.customer
            ? input.customer.existingId
            : undefined);
        if (
          old &&
          input.customer &&
          (!('existingId' in input.customer) || input.customer.existingId !== old.customer_id)
        )
          fail(422, 'CUSTOMER_FIXED', 'Клиент этой брони не меняется.');
        const lockedCustomer = await lockBookingCustomer(c, input, customerId, false);
        const sameTarget =
          old &&
          old.target_type === input.target.type &&
          (old.target_vehicle_id ??
            old.target_model_id ??
            old.target_brand_id ??
            old.target_group_id) === input.target.id;
        const models = sameTarget
          ? (
              await c.query(
                'SELECT model_id FROM booking_eligible_models WHERE booking_id=$1 ORDER BY model_id',
                [bookingId],
              )
            ).rows.map((x) => x.model_id)
          : await this.s.models(c, input.target);
        const prepared = await prepareBookingTerms(
          c,
          this.s,
          input,
          r,
          models,
          customerId,
          lockedCustomer,
          bookingId,
        );
        const { startAt, endAt } = prepared;
        const targets = ['vehicle', 'model', 'brand', 'equivalence_group'].map((t) =>
          input.target.type === t ? input.target.id : null,
        );
        const row = (
          await c.query<BookingRow>(
            'UPDATE bookings SET start_at=$2,end_at=$3,target_type=$4,target_vehicle_id=$5,target_model_id=$6,target_brand_id=$7,target_group_id=$8,version=version+1,updated_at=now() WHERE id=$1 RETURNING *',
            [bookingId, startAt, endAt, input.target.type, ...targets],
          )
        ).rows[0];
        await recordBookingTerms(c, this.s, input, r, models, row, prepared, 'bookings.terms');
        return row;
      },
      false,
    );
  }
  assign(input: AssignVehicleInput, r: AuthRequest, bookingId: number) {
    return this.s.commands.run(
      r,
      'bookings.assign',
      { bookingId, ...input },
      async (c) => {
        await scheduleLock(c);
        const booking = (
          await c.query<BookingRow>('SELECT * FROM bookings WHERE id=$1 FOR UPDATE', [bookingId])
        ).rows[0];
        if (!booking || booking.version !== input.expectedVersion || booking.status !== 'confirmed')
          fail(409, 'BOOKING_VERSION_CONFLICT', 'Перечитайте актуальную бронь.');
        if (booking.target_type === 'vehicle' && !input.vehicleId)
          fail(422, 'TARGET_FIXED', 'Для брони конкретного автомобиля необходимо назначение.');
        const models = (
          await c.query('SELECT model_id FROM booking_eligible_models WHERE booking_id=$1', [
            bookingId,
          ])
        ).rows.map((row) => row.model_id);
        if (input.vehicleId) {
          const vehicle = (
            await c.query('SELECT * FROM vehicles WHERE id=$1 FOR SHARE', [input.vehicleId])
          ).rows[0];
          if (!vehicle || vehicle.archived_at || !models.includes(vehicle.model_id))
            fail(422, 'VEHICLE_NOT_ELIGIBLE', 'Машина не входит в допустимый набор.');
        }
        const target: Target = {
          type: booking.target_type,
          id:
            booking.target_type === 'vehicle'
              ? input.vehicleId
              : (booking.target_model_id ?? booking.target_brand_id ?? booking.target_group_id),
        } as Target;
        if (input.vehicleId)
          await this.s.assertAssignable(
            c,
            input.vehicleId,
            booking.start_at.toISOString(),
            booking.end_at.toISOString(),
            bookingId,
          );
        const result = await this.s.evaluate(c, {
          id: bookingId,
          target,
          models,
          startAt: booking.start_at.toISOString(),
          endAt: booking.end_at.toISOString(),
          vehicleId: input.vehicleId,
        });
        this.s.accept(result, input.riskAcceptance);
        await c.query(
          'UPDATE schedule_blocks SET retired_at=now() WHERE booking_id=$1 AND retired_at IS NULL',
          [bookingId],
        );
        if (input.vehicleId)
          await this.s.assignment(
            c,
            bookingId,
            input.vehicleId,
            booking.start_at,
            booking.end_at,
            r.auth!.user.id,
            input.reason,
          );
        if (result.status !== 'feasible')
          await c.query(
            'INSERT INTO booking_risks(booking_id,snapshot,reason,created_by) VALUES ($1,$2,$3,$4)',
            [bookingId, JSON.stringify(result), input.riskAcceptance!.reason, r.auth!.user.id],
          );
        const row = (
          await c.query<BookingRow>(
            "UPDATE bookings SET version=version+1,updated_at=now(),target_vehicle_id=CASE WHEN target_type='vehicle' THEN $2 ELSE target_vehicle_id END WHERE id=$1 RETURNING *",
            [bookingId, input.vehicleId],
          )
        ).rows[0];
        if (booking.target_type === 'vehicle' && input.vehicleId !== booking.target_vehicle_id)
          await c.query(
            `INSERT INTO booking_terms(booking_id,revision,quote_id,snapshot,reason,created_by) SELECT booking_id,$2,quote_id,jsonb_set(snapshot,'{target}', $3::jsonb),$4,$5 FROM booking_terms WHERE booking_id=$1 ORDER BY revision DESC LIMIT 1`,
            [bookingId, row.version, JSON.stringify(target), input.reason, r.auth!.user.id],
          );
        await this.s.event(c, r, 'booking', bookingId, row.version, 'bookings.assigned', {
          reason: input.reason,
          vehicleId: input.vehicleId,
          ...(result.status !== 'feasible'
            ? {
                availabilityStatus: result.status,
                availabilityComment: input.riskAcceptance?.reason,
              }
            : {}),
        });
        return row;
      },
      false,
    );
  }
  private async inspectMove(
    c: PoolClient,
    bookingId: number,
    startAt: string,
    vehicleId: number,
    actor: number,
  ) {
    const b = (
      await c.query<MoveBookingRow>(
        `SELECT b.*,s.vehicle_id, t.snapshot FROM bookings b LEFT JOIN schedule_blocks s ON s.booking_id=b.id AND s.retired_at IS NULL JOIN LATERAL (SELECT snapshot FROM booking_terms WHERE booking_id=b.id ORDER BY revision DESC LIMIT 1) t ON true WHERE b.id=$1`,
        [bookingId],
      )
    ).rows[0];
    if (!b || b.status !== 'confirmed') fail(404, 'NOT_FOUND', 'Подтверждённая бронь не найдена.');
    if (b.snapshot.operationKind !== 'initial')
      fail(422, 'MOVE_UNSUPPORTED', 'Перенос этой брони требует редактирования условий.');
    const models = (
      await c.query<{ model_id: number }>(
        'SELECT model_id FROM booking_eligible_models WHERE booking_id=$1',
        [bookingId],
      )
    ).rows.map((x) => x.model_id);
    const v = (
      await c.query<MoveVehicleRow>(
        'SELECT v.id,v.model_id,v.plate,v.is_ready,v.archived_at,m.pricing_group_id FROM vehicles v JOIN vehicle_models m ON m.id=v.model_id WHERE v.id=$1',
        [vehicleId],
      )
    ).rows[0];
    if (!v || v.archived_at) fail(404, 'NOT_FOUND', 'Автомобиль не найден.');
    const endAt = new Date(
      Date.parse(startAt) + (Date.parse(b.end_at.toString()) - Date.parse(b.start_at.toString())),
    ).toISOString();
    const changedModel = !models.includes(v.model_id);
    // booking_target CHECK guarantees exactly one non-null target ID.
    const target: Target =
      changedModel || b.target_type === 'vehicle'
        ? { type: 'vehicle' as const, id: vehicleId }
        : {
            type: b.target_type,
            id: (b.target_model_id ?? b.target_brand_id ?? b.target_group_id)!,
          };
    const nextModels = changedModel ? [v.model_id] : models;
    const changedTariff = v.pricing_group_id !== b.snapshot.periods[0]?.pricingGroup?.id;
    let quote: Awaited<ReturnType<typeof previewBooking>> | undefined;
    if (changedTariff) {
      const source: Partial<NonNullable<Calculation['overrides']>> = b.snapshot.overrides ?? {};
      const overrides: Partial<NonNullable<Calculation['overrides']>> = {};
      for (const key of [
        'customDailyRateRub',
        'mileageLimitKm',
        'discountRub',
        'discountBps',
      ] as const)
        if (source[key] !== undefined) Object.assign(overrides, { [key]: source[key] });
      if (Object.keys(overrides).length)
        overrides.reason = source.reason || 'Ранее согласованные индивидуальные условия';
      const pricing: z.infer<typeof bookingPricing> = {
        startAt,
        contractDays: b.snapshot.contractDays,
        dailyMileagePackageKm: b.snapshot.dailyMileagePackageKm,
        ...(Object.keys(overrides).length
          ? {
              overrides: {
                ...overrides,
                reason: overrides.reason || 'Ранее согласованные индивидуальные условия',
              },
            }
          : {}),
        ...(b.snapshot.nonBillableDays?.length
          ? {
              nonBillableDays: b.snapshot.nonBillableDays.map(
                (d: Calculation['nonBillableDays'][number]) => ({
                  dayIndex: d.dayIndex,
                  reason: d.reason,
                }),
              ),
            }
          : {}),
      };
      quote = await previewBooking(c, target, pricing, nextModels, actor);
    }
    const inspection = await this.s.inspect(c, {
      id: bookingId,
      target,
      models: nextModels,
      startAt,
      endAt,
      vehicleId,
    });
    const blocked = !v.is_ready || inspection.conflicts.length > 0;
    return {
      ...inspection,
      booking: b,
      vehicle: v,
      startAt,
      endAt,
      vehicleId,
      blocked,
      models: nextModels,
      target,
      changedModel,
      changedTariff,
      quote,
    };
  }
  previewMove(input: MovePreviewInput, r: AuthRequest, bookingId: number) {
    return this.s.db.transaction(async (c) => {
      await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const p = await this.inspectMove(
        c,
        bookingId,
        input.startAt,
        input.vehicleId,
        r.auth!.user.id,
      );
      return {
        bookingId,
        expectedVersion: p.booking.version,
        oldStartAt: p.booking.start_at,
        oldEndAt: p.booking.end_at,
        oldVehicleId: p.booking.vehicle_id,
        oldPriceRub: p.booking.snapshot.finalTotalRub,
        startAt: p.startAt,
        endAt: p.endAt,
        vehicleId: p.vehicleId,
        vehiclePlate: p.vehicle.plate,
        priceRub: p.quote?.calculation.finalTotalRub ?? p.booking.snapshot.finalTotalRub,
        quoteToken: p.quote?.previewToken,
        changedModel: p.changedModel,
        blocked: p.blocked,
        conflicts: p.conflicts,
        availability: p.availability,
      };
    });
  }
  move(input: MoveBookingInput, r: AuthRequest, bookingId: number) {
    return this.s.commands.run(
      r,
      'bookings.move',
      { bookingId, ...input },
      async (c) => {
        await scheduleLock(c);
        const p = await this.inspectMove(
          c,
          bookingId,
          input.startAt,
          input.vehicleId,
          r.auth!.user.id,
        );
        if (p.booking.version !== input.expectedVersion)
          fail(409, 'BOOKING_VERSION_CONFLICT', 'Бронь изменилась. Проверьте перенос снова.');
        if (p.blocked)
          fail(
            409,
            'VEHICLE_ASSIGNMENT_CONFLICT',
            'Выбранный автомобиль недоступен на этот период.',
            { conflicts: p.conflicts },
          );
        if (p.availability.token !== input.availabilityToken)
          fail(409, 'MOVE_PREVIEW_STALE', 'Расписание изменилось. Проверьте перенос снова.');
        if (p.quote?.previewToken !== input.quoteToken)
          fail(409, 'MOVE_PREVIEW_STALE', 'Стоимость изменилась. Проверьте перенос снова.');
        if (
          p.booking.vehicle_id === input.vehicleId &&
          Date.parse(p.booking.start_at.toString()) === Date.parse(input.startAt)
        )
          fail(422, 'MOVE_UNCHANGED', 'Бронь не перемещена.');
        const delta = Date.parse(input.startAt) - Date.parse(p.booking.start_at.toString());
        const shift = (value: string) => new Date(Date.parse(value) + delta).toISOString();
        const old = p.booking.snapshot;
        const snapshot = p.quote
          ? { ...p.quote.calculation, target: p.target, eligibleModels: p.models }
          : {
              ...old,
              startAt: p.startAt,
              agreedReturnAt: p.endAt,
              target: p.target,
              eligibleModels: p.models,
              periods: old.periods?.map((item) => ({
                ...item,
                startsAt: shift(item.startsAt),
                endsAt: shift(item.endsAt),
              })),
              dayLines: old.dayLines?.map((item) => ({
                ...item,
                startAt: shift(item.startAt),
                endAt: shift(item.endAt),
              })),
              ...(old.pricingBasis
                ? {
                    pricingBasis: {
                      ...old.pricingBasis,
                      startsAt: shift(old.pricingBasis.startsAt),
                      endsAt: shift(old.pricingBasis.endsAt),
                    },
                  }
                : {}),
            };
        let quoteId: number | undefined;
        if (p.quote) {
          const quote = (
            await c.query<{ id: number }>(
              `INSERT INTO pricing_quotes(created_by,confirmed_by,expires_at,confirmed_at,version,input,snapshot,confirmed_overrides) VALUES ($1,$1,now()+interval '30 minutes',now(),2,$2,$3,$4) RETURNING id`,
              [
                r.auth!.user.id,
                JSON.stringify(p.quote.input),
                JSON.stringify(p.quote.calculation),
                JSON.stringify(p.quote.calculation.overridesToConfirm),
              ],
            )
          ).rows[0];
          quoteId = quote.id;
          await audit(
            c,
            r.auth!.user.id,
            'pricing_quote',
            'pricing.confirmed',
            quoteId!,
            r.requestId,
            { context: 'booking_move', confirmedOverrides: p.quote.calculation.overridesToConfirm },
          );
          await c.query('INSERT INTO outbox_jobs(business_key,kind,payload) VALUES ($1,$2,$3)', [
            'pricing.confirmed:' + quoteId,
            'pricing.confirmed',
            JSON.stringify({ id: quoteId, version: 2 }),
          ]);
        }
        await c.query(
          'UPDATE schedule_blocks SET retired_at=now() WHERE booking_id=$1 AND retired_at IS NULL',
          [bookingId],
        );
        const row = (
          await c.query<BookingRow>(
            `UPDATE bookings SET start_at=$2,end_at=$3,target_type=$4,target_vehicle_id=$5,target_model_id=$6,target_brand_id=$7,target_group_id=$8,version=version+1,updated_at=now() WHERE id=$1 RETURNING *`,
            [
              bookingId,
              p.startAt,
              p.endAt,
              p.target.type,
              p.target.type === 'vehicle' ? p.target.id : null,
              p.target.type === 'model' ? p.target.id : null,
              p.target.type === 'brand' ? p.target.id : null,
              p.target.type === 'equivalence_group' ? p.target.id : null,
            ],
          )
        ).rows[0];
        if (p.changedModel) {
          await c.query('DELETE FROM booking_eligible_models WHERE booking_id=$1', [bookingId]);
          await c.query('INSERT INTO booking_eligible_models(booking_id,model_id) VALUES ($1,$2)', [
            bookingId,
            p.vehicle.model_id,
          ]);
        }
        await this.s.assignment(
          c,
          bookingId,
          input.vehicleId,
          p.startAt,
          p.endAt,
          r.auth!.user.id,
          input.reason,
        );
        await c.query(
          `INSERT INTO booking_terms(booking_id,revision,quote_id,snapshot,reason,created_by) SELECT booking_id,$2,coalesce($3,quote_id),$4,$5,$6 FROM booking_terms WHERE booking_id=$1 ORDER BY revision DESC LIMIT 1`,
          [
            bookingId,
            row.version,
            quoteId ?? null,
            JSON.stringify(snapshot),
            input.reason,
            r.auth!.user.id,
          ],
        );
        if (p.availability.status !== 'feasible')
          await c.query(
            'INSERT INTO booking_risks(booking_id,snapshot,reason,created_by) VALUES ($1,$2,$3,$4)',
            [
              bookingId,
              JSON.stringify(p.availability),
              'Перенос брони при неполной доступности автопарка',
              r.auth!.user.id,
            ],
          );
        await this.s.event(c, r, 'booking', bookingId, row.version, 'bookings.moved', {
          previousVehicleId: p.booking.vehicle_id,
          vehicleId: input.vehicleId,
          previousStartAt: p.booking.start_at,
          startAt: p.startAt,
          previousPriceRub: old.finalTotalRub,
          priceRub: snapshot.finalTotalRub,
          reason: input.reason,
          ...(p.availability.status !== 'feasible'
            ? { availabilityStatus: p.availability.status }
            : {}),
        });
        return row;
      },
      false,
    );
  }
}
