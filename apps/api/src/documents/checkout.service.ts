import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { CommandsService } from '../platform/commands.service';
import { AuthRequest, audit, fail } from '../platform/security';
import { lockBooking, lockConfirmedBooking } from './booking-documents';
import type { IssueInput, StopCheckoutInput } from './document.dto';
import { checkoutState, guardCheckoutChange } from './checkout-state';
import { assertInspectionIdle, listInspectionWork } from './inspection-work';
import { recordActSignature, recordContractSignature } from './document-signing';
import { actMatchesCustomer } from './act-customer';
import { recordRentalStart } from '../push/rental-event';

async function currentPickupAct(
  c: PoolClient,
  bookingId: number,
  bookingVersion: number,
  inspectionId: number | null,
  vehicleId: number,
) {
  const {
    rows: [act],
  } = await c.query<{ id: number; revisionId: number; current: boolean }>(
    `SELECT a.id,i.id AS "revisionId",COALESCE(a.status='ready' AND a.booking_version=$2
           AND i.id=$3 AND i.vehicle_id=$4 AND ${actMatchesCustomer},false) AS "current"
     FROM inspection_act_versions a JOIN inspection_revisions i ON i.id=a.inspection_revision_id
     JOIN bookings b ON b.id=a.booking_id JOIN customers u ON u.id=b.customer_id
     WHERE a.booking_id=$1 AND i.kind='pickup' ORDER BY a.id DESC LIMIT 1`,
    [bookingId, bookingVersion, inspectionId, vehicleId],
  );
  return act?.current ? act : undefined;
}

@Injectable()
export class CheckoutService {
  constructor(private readonly commands: CommandsService) {}

  state(c: PoolClient, id: number) {
    return checkoutState(c, id);
  }

  start(request: AuthRequest, id: number, version: number) {
    return this.commands.run(
      request,
      'checkout.start',
      { id, version },
      async (c) => {
        await lockBooking(c, id, version);
        const inserted = await c.query(
          `INSERT INTO booking_checkouts(booking_id,started_by,started_at) VALUES($1,$2,clock_timestamp())
           ON CONFLICT (booking_id) DO UPDATE SET started_by=excluded.started_by,
             started_at=clock_timestamp(),stopped_at=NULL
           WHERE booking_checkouts.stopped_at IS NOT NULL RETURNING booking_id`,
          [id, request.auth!.user.id],
        );
        if (inserted.rowCount) await recordRentalStart(c, request, id, 'checkout.started');
        return { id };
      },
      false,
    );
  }

  stop(request: AuthRequest, id: number, input: StopCheckoutInput) {
    return this.commands.run(
      request,
      'checkout.stop',
      { id, input },
      async (c) => {
        const booking = await lockConfirmedBooking(c, id, input.expectedBookingVersion);
        await c.query('SELECT id FROM customers WHERE id=$1 FOR SHARE', [booking.customerId]);
        const state = await guardCheckoutChange(c, id);
        if (!state || state.startedAt !== input.expectedStartedAt)
          fail(409, 'CHECKOUT_CHANGED', 'Оформление изменилось. Проверьте актуальные данные.');
        const work = await listInspectionWork(c, id, booking.version);
        if (!input.confirmed && (state.hasChanges || work.some((row) => row.kind === 'pickup')))
          fail(
            409,
            'CHECKOUT_STOP_CONFIRMATION_REQUIRED',
            'В оформлении появились данные. Подтвердите прекращение оформления.',
          );
        await c.query(
          'UPDATE booking_checkouts SET stopped_at=clock_timestamp() WHERE booking_id=$1',
          [id],
        );
        await c.query("DELETE FROM inspection_work WHERE booking_id=$1 AND kind='pickup'", [id]);
        await audit(c, request.auth!.user.id, 'booking', 'checkout.stopped', id, request.requestId);
        return { id };
      },
      false,
    );
  }

  signAct(
    request: AuthRequest,
    id: number,
    version: number,
    revisionId: number,
    actVersionId: number,
  ) {
    return this.commands.run(
      request,
      'checkout.signAct',
      { id, version, revisionId, actVersionId },
      async (c) => {
        const booking = await lockBooking(c, id, version);
        await c.query('SELECT id FROM customers WHERE id=$1 FOR SHARE', [booking.customerId]);
        const state = await guardCheckoutChange(c, id, true);
        if (!state) fail(422, 'CHECKOUT_REQUIRED', 'Начните оформление договора в карточке брони.');
        await assertInspectionIdle(c, id, booking.version, 'pickup');
        const actual = (
          await c.query<{ id: number; vehicle_id: number }>(
            "SELECT id,vehicle_id FROM inspection_revisions WHERE booking_id=$1 AND kind='pickup' ORDER BY revision DESC LIMIT 1",
            [id],
          )
        ).rows[0];
        if (actual?.id !== revisionId || actual.vehicle_id !== booking.vehicleId)
          fail(
            409,
            'INSPECTION_VERSION_CONFLICT',
            'Подтвердите бумажный акт по актуальному осмотру выдачи.',
          );
        const act = await currentPickupAct(c, id, version, revisionId, booking.vehicleId);
        if (act?.id !== actVersionId)
          fail(422, 'ACT_NOT_READY', 'Подтвердите подпись актуальной готовой версии PDF акта.');
        await recordActSignature(c, request, id, revisionId, actVersionId);
        return { id: revisionId };
      },
      false,
    );
  }

  issue(request: AuthRequest, id: number, input: IssueInput) {
    const { expectedBookingVersion: version, contractVersionId, actVersionId } = input;
    return this.commands.run(
      request,
      'checkout.issue',
      { id, version, contractVersionId, actVersionId },
      async (c) => {
        const booking = await lockBooking(c, id, version);
        const customer = (
          await c.query<{ is_blocked: boolean; version: number }>(
            'SELECT is_blocked,version FROM customers WHERE id=$1 FOR SHARE',
            [booking.customerId],
          )
        ).rows[0]!;
        if (customer.is_blocked)
          fail(422, 'CUSTOMER_BLOCKED', 'Клиент заблокирован для выдачи автомобиля.');
        const state = await checkoutState(c, id);
        if (!state) fail(422, 'CHECKOUT_REQUIRED', 'Начните оформление договора в карточке брони.');
        if (state.issuedAt) fail(409, 'VEHICLE_ALREADY_ISSUED', 'Автомобиль уже выдан.');
        await assertInspectionIdle(c, id, booking.version, 'pickup');
        const contract = (
          await c.query<{ id: number }>(
            `SELECT id FROM contract_versions WHERE id=$1 AND status='ready'
           AND (snapshot->>'bookingVersion')::int=$2 AND (snapshot->'customer'->>'version')::int=$3`,
            [state.contractId, version, customer.version],
          )
        ).rows[0];
        const act = await currentPickupAct(c, id, version, state.inspectionId, booking.vehicleId);
        if (!contract || !act)
          fail(422, 'DOCUMENTS_NOT_READY', 'Сформируйте актуальные PDF договора и акта выдачи.');
        if (contractVersionId !== contract.id || actVersionId !== act.id)
          fail(
            409,
            'ISSUE_DOCUMENTS_CHANGED',
            'Договор или акт обновился. Проверьте актуальные PDF перед выдачей.',
          );
        const vehicle = (
          await c.query<{ is_ready: boolean; busy: boolean }>(
            `SELECT v.is_ready,EXISTS(SELECT 1 FROM booking_checkouts x WHERE x.issued_vehicle_id=v.id AND to_jsonb(x)->>'returned_at' IS NULL)
         OR EXISTS(SELECT 1 FROM schedule_blocks a WHERE a.vehicle_id=v.id AND a.booking_id IS DISTINCT FROM $2
           AND a.retired_at IS NULL AND a.start_at<=now() AND a.end_at>now()) AS busy
         FROM vehicles v WHERE v.id=$1 AND v.archived_at IS NULL FOR SHARE OF v`,
            [booking.vehicleId, id],
          )
        ).rows[0];
        if (!vehicle?.is_ready || vehicle.busy)
          fail(422, 'VEHICLE_NOT_READY', 'Автомобиль занят или не готов к выдаче.');
        if (!state.rentReceived || !state.depositReceived)
          fail(422, 'RECEIPTS_REQUIRED', 'Подтвердите получение оплаты и согласованного залога.');
        await recordContractSignature(c, request, id, contract.id);
        await recordActSignature(c, request, id, act.revisionId, act.id);
        await c.query(
          `UPDATE booking_checkouts SET issued_at=now(),issued_by=$2,issued_vehicle_id=$3,issued_contract_id=$4
         WHERE booking_id=$1`,
          [id, request.auth!.user.id, booking.vehicleId, contract.id],
        );
        await audit(c, request.auth!.user.id, 'booking', 'checkout.issued', id, request.requestId, {
          vehicleId: booking.vehicleId,
          contractVersionId: contract.id,
          inspectionRevisionId: act.revisionId,
          actVersionId: act.id,
        });
        return { id };
      },
      false,
    );
  }
}
