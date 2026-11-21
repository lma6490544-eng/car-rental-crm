import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database.service';
import { fail } from '../platform/security';
import type { Calculation } from '../pricing/calculate';
import type { BookingRow } from './booking-write';
import { SchedulingService } from './scheduling.service';
import type { Target } from './scheduling.service';

type BookingDetailRow = Omit<BookingRow, 'target_type'> & {
  target_type: Target['type'];
  customer_name: string;
  vehicle_id: number | null;
};
type BookingVehicleOption = {
  id: number;
  modelId: number;
  pricingGroupId: number;
  isReady: boolean;
  busy: boolean;
};
type BookingTermsRow = {
  id: number;
  booking_id: number;
  revision: number;
  quote_id: number;
  snapshot: Calculation;
  reason: string;
  created_by: number;
  created_at: Date;
};
type BookingRiskRow = {
  id: number;
  booking_id: number;
  snapshot: Awaited<ReturnType<SchedulingService['evaluate']>>;
  reason: string;
  created_by: number;
  created_at: Date;
};

@Injectable()
export class BookingQueryService {
  constructor(
    private readonly db: DatabaseService,
    private readonly scheduling: SchedulingService,
  ) {}

  async get(bookingId: number) {
    return this.db.transaction(async (c) => {
      await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const booking = (
        await c.query<BookingDetailRow>(
          `SELECT b.*,c.display_name AS customer_name,s.vehicle_id FROM bookings b JOIN customers c ON c.id=b.customer_id LEFT JOIN schedule_blocks s ON s.booking_id=b.id AND s.retired_at IS NULL WHERE b.id=$1`,
          [bookingId],
        )
      ).rows[0];
      if (!booking) fail(404, 'NOT_FOUND', 'Бронь не найдена.');
      const models = (
        await c.query<{ model_id: number }>(
          'SELECT model_id FROM booking_eligible_models WHERE booking_id=$1',
          [booking.id],
        )
      ).rows.map((x) => x.model_id);
      const inspection = await this.scheduling.inspect(c, {
        id: booking.id,
        target: {
          type: booking.target_type,
          // The booking_target database constraint guarantees one non-null ID.
          id: (booking.target_vehicle_id ??
            booking.target_model_id ??
            booking.target_brand_id ??
            booking.target_group_id)!,
        },
        models,
        startAt: booking.start_at.toISOString(),
        endAt: booking.end_at.toISOString(),
        vehicleId: booking.vehicle_id,
      });
      const vehicleOptions = (
        await c.query<BookingVehicleOption>(
          `SELECT v.id,v.model_id AS "modelId",m.pricing_group_id AS "pricingGroupId",v.is_ready AS "isReady",EXISTS(SELECT 1 FROM schedule_blocks s WHERE s.vehicle_id=v.id AND s.retired_at IS NULL AND (s.booking_id IS NULL OR s.booking_id<>$1) AND s.start_at<b.end_at AND s.end_at>b.start_at) AS busy FROM vehicles v JOIN vehicle_models m ON m.id=v.model_id CROSS JOIN bookings b WHERE b.id=$1 AND v.archived_at IS NULL`,
          [booking.id],
        )
      ).rows;
      return {
        ...booking,
        ...inspection,
        vehicleOptions,
        terms: (
          await c.query<BookingTermsRow>(
            'SELECT * FROM booking_terms WHERE booking_id=$1 ORDER BY revision DESC',
            [booking.id],
          )
        ).rows,
        risks: (
          await c.query<BookingRiskRow>(
            'SELECT * FROM booking_risks WHERE booking_id=$1 ORDER BY id',
            [booking.id],
          )
        ).rows,
      };
    });
  }
}
