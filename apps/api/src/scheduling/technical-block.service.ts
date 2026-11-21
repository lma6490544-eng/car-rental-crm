import { Injectable } from '@nestjs/common';
import { AuthRequest, fail } from '../platform/security';
import { isDeepStrictEqual } from 'node:util';
import { SchedulingService, scheduleLock } from './scheduling.service';
import type { BookingRow } from './booking-write';
import type { TechnicalBlockInput } from './technical-block.dto';
import type { CancelBookingInput } from './booking.dto';

type TechnicalBlockRow = {
  id: number;
  vehicle_id: number;
  booking_id: null;
  kind: 'technical';
  start_at: Date;
  end_at: Date;
  reason: string;
  retired_at: Date | null;
  version: number;
  created_by: number;
  created_at: Date;
};
type TechnicalConflict = {
  id: number;
  vehicle_id: number;
  booking_id: number | null;
  kind: 'technical' | 'assignment';
  start_at: Date;
  end_at: Date;
  reason: string;
  version: number;
  booking_version: number | null;
  customer_name: string | null;
  overlap_start: Date;
  overlap_end: Date;
};
// schedule_blocks.booking_id FK guarantees the joined version for a booking conflict.
type BookingConflict = TechnicalConflict & { booking_id: number; booking_version: number };

@Injectable()
export class TechnicalBlockService {
  constructor(private readonly s: SchedulingService) {}
  preview(input: { vehicleId: number; startAt: string; endAt: string; blockId?: number }) {
    return this.s.db.transaction(async (c) => {
      await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      return this.s.technicalPreview(c, input);
    });
  }
  save(input: TechnicalBlockInput, r: AuthRequest, blockId?: number) {
    return this.s.commands.run(
      r,
      blockId ? 'schedule.update' : 'schedule.create',
      { blockId, ...input },
      async (c) => {
        await scheduleLock(c);
        if (blockId) {
          const old = (
            await c.query<TechnicalBlockRow>(
              "SELECT * FROM schedule_blocks WHERE id=$1 AND kind='technical' AND retired_at IS NULL FOR UPDATE",
              [blockId],
            )
          ).rows[0];
          if (!old || old.version !== input.expectedVersion || old.vehicle_id !== input.vehicleId)
            fail(409, 'VERSION_CONFLICT', 'Блокировка изменилась. Перечитайте данные.');
        }
        const preview: { conflicts: TechnicalConflict[]; token: string } =
          await this.s.technicalPreview(c, {
            vehicleId: input.vehicleId,
            startAt: input.startAt,
            endAt: input.endAt,
            ...(blockId ? { blockId } : {}),
          });
        if (preview.conflicts.some((x) => x.kind === 'technical'))
          fail(
            409,
            'TECHNICAL_BLOCK_CONFLICT',
            'Период пересекается с технической блокировкой. Измените существующую блокировку.',
            preview,
          );
        const affected = preview.conflicts.filter((x): x is BookingConflict => !!x.booking_id);
        const expected = affected
          .map((x) => ({ id: x.booking_id, expectedVersion: x.booking_version }))
          .sort((a, b) => a.id - b.id);
        const accepted = [...(input.displaceBookings ?? [])].sort((a, b) => a.id - b.id);
        if (
          affected.length &&
          (input.conflictsToken !== preview.token || !isDeepStrictEqual(expected, accepted))
        )
          fail(
            409,
            'TECHNICAL_BOOKINGS_CONFIRMATION_REQUIRED',
            'Подтвердите снятие назначений со всех затронутых броней.',
            preview,
          );
        if (!affected.length && accepted.length)
          fail(
            409,
            'TECHNICAL_PREVIEW_STALE',
            'Состав затронутых броней изменился. Проверьте период снова.',
            preview,
          );
        for (const conflict of affected) {
          const b = (
            await c.query<BookingRow>('SELECT * FROM bookings WHERE id=$1 FOR UPDATE', [
              conflict.booking_id,
            ])
          ).rows[0];
          if (!b || b.version !== conflict.booking_version || b.status !== 'confirmed')
            fail(409, 'BOOKING_VERSION_CONFLICT', 'Затронутая бронь изменилась.');
          await c.query(
            'UPDATE schedule_blocks SET retired_at=now(),version=version+1 WHERE id=$1',
            [conflict.id],
          );
          const model = (
            await c.query<{ model_id: number }>('SELECT model_id FROM vehicles WHERE id=$1', [
              input.vehicleId,
            ])
          ).rows[0].model_id;
          const changed = (
            await c.query<BookingRow>(
              `UPDATE bookings SET version=version+1,updated_at=now(),
                  target_type=CASE WHEN target_type='vehicle' THEN 'model' ELSE target_type END,
                  target_model_id=CASE WHEN target_type='vehicle' THEN $2 ELSE target_model_id END,target_vehicle_id=NULL WHERE id=$1 RETURNING *`,
              [b.id, model],
            )
          ).rows[0];
          if (b.target_type === 'vehicle')
            await this.s.reviseTarget(
              c,
              b.id,
              changed.version,
              { type: 'model', id: model },
              input.reason,
              r.auth!.user.id,
            );
          // The relation is recorded after the block exists below.
        }
        const row = blockId
          ? (
              await c.query<TechnicalBlockRow>(
                'UPDATE schedule_blocks SET start_at=$2,end_at=$3,reason=$4,version=version+1 WHERE id=$1 RETURNING *',
                [blockId, input.startAt, input.endAt, input.reason],
              )
            ).rows[0]
          : (
              await c.query<TechnicalBlockRow>(
                "INSERT INTO schedule_blocks(vehicle_id,kind,start_at,end_at,reason,created_by) VALUES ($1,'technical',$2,$3,$4,$5) RETURNING *",
                [input.vehicleId, input.startAt, input.endAt, input.reason, r.auth!.user.id],
              )
            ).rows[0];
        for (const conflict of affected)
          await this.s.event(
            c,
            r,
            'booking',
            conflict.booking_id,
            conflict.booking_version + 1,
            'bookings.displaced',
            { reason: input.reason, previousVehicleId: input.vehicleId, technicalBlockId: row.id },
          );
        await this.s.event(
          c,
          r,
          'schedule_block',
          row.id,
          row.version,
          blockId ? 'schedule.updated' : 'schedule.created',
          { reason: input.reason, displacedBookings: expected.map((x) => x.id) },
        );
        return row;
      },
      false,
    );
  }
  cancel(input: CancelBookingInput, r: AuthRequest, blockId: number) {
    return this.s.commands.run(
      r,
      'schedule.cancel',
      { blockId, ...input },
      async (c) => {
        await scheduleLock(c);
        const row = (
          await c.query<TechnicalBlockRow>(
            "UPDATE schedule_blocks SET retired_at=now(),version=version+1 WHERE id=$1 AND version=$2 AND kind='technical' AND retired_at IS NULL RETURNING *",
            [blockId, input.expectedVersion],
          )
        ).rows[0];
        if (!row) fail(409, 'VERSION_CONFLICT', 'Блокировка изменилась. Обновите данные.');
        await this.s.event(c, r, 'schedule_block', blockId, row.version, 'schedule.cancelled', {
          reason: input.reason,
        });
        return row;
      },
      false,
    );
  }
}
