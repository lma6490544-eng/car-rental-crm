import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { guardCheckoutChange } from './checkout-state';
import { CommandsService } from '../platform/commands.service';
import { AuthRequest, audit, fail } from '../platform/security';
import { lockBooking, vehicleSnapshot } from './booking-documents';
import type { VehicleSnapshot } from './booking-documents';
import type { InspectionKind, InspectionInput } from './document.dto';
import { listInspectionWork } from './inspection-work';

type InspectionRevision = {
  id: number;
  vehicleId: number;
  kind: InspectionKind;
  revision: number;
  vehicleSnapshot: VehicleSnapshot;
  mileageKm: number;
  fuelEighths: number;
  noDamage: boolean;
  damageNotes: string;
  specialNotes: string;
  noPhotosAcknowledged: boolean;
  createdAt: Date;
  photoIds: string[];
};

@Injectable()
export class InspectionsService {
  constructor(private readonly commands: CommandsService) {}

  async list(c: PoolClient, bookingId: number) {
    return (
      await c.query<InspectionRevision>(
        `SELECT r.id,r.vehicle_id AS "vehicleId",r.kind,r.revision,r.vehicle_snapshot AS "vehicleSnapshot",
       r.mileage_km AS "mileageKm",r.fuel_eighths AS "fuelEighths",r.no_damage AS "noDamage",
       r.damage_notes AS "damageNotes",r.special_notes AS "specialNotes",
       r.no_photos_acknowledged AS "noPhotosAcknowledged",r.created_at AS "createdAt",
       ARRAY(SELECT p.file_id FROM inspection_revision_photos p WHERE p.revision_id=r.id ORDER BY p.file_id) AS "photoIds"
       FROM inspection_revisions r WHERE r.booking_id=$1 ORDER BY r.revision DESC,r.kind`,
        [bookingId],
      )
    ).rows;
  }

  start(
    request: AuthRequest,
    bookingId: number,
    kind: InspectionKind,
    version: number,
    replaceWorkId?: number,
  ) {
    return this.commands.run(
      request,
      'inspections.start',
      { bookingId, kind, version, replaceWorkId },
      async (c) => {
        await lockBooking(c, bookingId, version);
        if (kind === 'pickup' && !(await guardCheckoutChange(c, bookingId, true)))
          fail(422, 'CHECKOUT_REQUIRED', 'Начните оформление договора в карточке брони.');
        const operatorId = request.auth!.user.id;
        const work = (await listInspectionWork(c, bookingId, version)).find(
          (row) => row.kind === kind,
        );
        if (work?.operatorId === operatorId) return { id: work.id };
        if (replaceWorkId !== undefined && work?.id !== replaceWorkId)
          fail(409, 'INSPECTION_WORK_CHANGED', 'Статус осмотра изменился. Проверьте карточку.');
        if (work && replaceWorkId === undefined)
          fail(409, 'INSPECTION_IN_PROGRESS', 'Осмотр уже заполняет ' + work.operatorName + '.');
        await c.query('DELETE FROM inspection_work WHERE booking_id=$1 AND kind=$2', [
          bookingId,
          kind,
        ]);
        const result = (
          await c.query<{ id: number }>(
            'INSERT INTO inspection_work(booking_id,booking_version,kind,operator_id) VALUES($1,$2,$3,$4) RETURNING id',
            [bookingId, version, kind, operatorId],
          )
        ).rows[0]!;
        await audit(c, operatorId, 'booking', 'inspections.started', bookingId, request.requestId, {
          kind,
          workId: result.id,
          previousOperatorId: work?.operatorId,
        });
        return result;
      },
      false,
    );
  }

  cancel(
    request: AuthRequest,
    bookingId: number,
    kind: InspectionKind,
    version: number,
    workId: number,
  ) {
    return this.commands.run(
      request,
      'inspections.cancel',
      { bookingId, kind, version, workId },
      async (c) => {
        await lockBooking(c, bookingId, version);
        const operatorId = request.auth!.user.id;
        const result = await c.query(
          'DELETE FROM inspection_work WHERE booking_id=$1 AND booking_version=$2 AND kind=$3 AND id=$4 AND operator_id=$5',
          [bookingId, version, kind, workId, operatorId],
        );
        if (!result.rowCount)
          fail(409, 'INSPECTION_WORK_CHANGED', 'Статус осмотра изменился. Проверьте карточку.');
        await audit(
          c,
          operatorId,
          'booking',
          'inspections.cancelled',
          bookingId,
          request.requestId,
          { kind, workId },
        );
        return { id: workId };
      },
      false,
    );
  }

  save(request: AuthRequest, bookingId: number, kind: InspectionKind, input: InspectionInput) {
    return this.commands.run(
      request,
      'inspections.save',
      { bookingId, kind, input },
      async (c) => {
        const booking = await lockBooking(c, bookingId, input.expectedBookingVersion);
        if (kind === 'pickup') await guardCheckoutChange(c, bookingId, true);
        const work = (await listInspectionWork(c, bookingId, booking.version)).find(
          (row) => row.kind === kind,
        );
        if (work && (work.id !== input.workId || work.operatorId !== request.auth!.user.id))
          fail(409, 'INSPECTION_IN_PROGRESS', 'Осмотр заполняет ' + work.operatorName + '.');
        if (!work && input.workId !== undefined)
          fail(409, 'INSPECTION_WORK_CHANGED', 'Статус осмотра изменился. Проверьте карточку.');
        const last =
          (
            await c.query<{ revision: number }>(
              'SELECT revision FROM inspection_revisions WHERE booking_id=$1 AND kind=$2 ORDER BY revision DESC LIMIT 1',
              [bookingId, kind],
            )
          ).rows[0]?.revision ?? 0;
        if (last !== input.expectedRevision)
          fail(409, 'INSPECTION_VERSION_CONFLICT', 'Осмотр изменился. Сверьте последнюю редакцию.');
        if (kind === 'pickup' && !input.photoIds.length && !input.acknowledgeNoPhotos)
          fail(422, 'NO_PICKUP_PHOTOS', 'Подтвердите сохранение осмотра без фото.');
        if (input.photoIds.length) {
          const photos = await c.query(
            `SELECT id FROM private_files WHERE id=ANY($1::uuid[]) AND booking_id=$2
           AND category='inspection_photo' AND status='ready' AND vehicle_id=$3 AND inspection_kind=$4
           AND (delete_after IS NULL OR delete_after>clock_timestamp()) FOR SHARE`,
            [input.photoIds, bookingId, booking.vehicleId, kind],
          );
          if (photos.rowCount !== input.photoIds.length)
            fail(422, 'PHOTOS_NOT_AVAILABLE', 'Дождитесь загрузки фото или удалите его из формы.');
        }
        const vehicle = await vehicleSnapshot(c, booking.vehicleId);
        const revision = last + 1;
        const { id } = (
          await c.query<{ id: number }>(
            `INSERT INTO inspection_revisions(booking_id,vehicle_id,kind,revision,vehicle_snapshot,mileage_km,
         fuel_eighths,no_damage,damage_notes,special_notes,no_photos_acknowledged,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
            [
              bookingId,
              booking.vehicleId,
              kind,
              revision,
              JSON.stringify(vehicle),
              input.mileageKm,
              input.fuelEighths,
              input.noDamage,
              input.damageNotes,
              input.specialNotes,
              kind === 'pickup' && input.photoIds.length === 0 && input.acknowledgeNoPhotos,
              request.auth!.user.id,
            ],
          )
        ).rows[0]!;
        await c.query('INSERT INTO inspection_revision_photos SELECT $1, unnest($2::uuid[])', [
          id,
          input.photoIds,
        ]);
        if (work) await c.query('DELETE FROM inspection_work WHERE id=$1', [work.id]);
        await audit(
          c,
          request.auth!.user.id,
          'booking',
          'inspections.saved',
          bookingId,
          request.requestId,
          { id, kind, revision, noPhotos: !input.photoIds.length },
        );
        return { id, revision };
      },
      false,
    );
  }
}
