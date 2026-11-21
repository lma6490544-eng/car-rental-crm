import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database.service';
import { SchedulingService } from './scheduling.service';
import { bookingSummaries } from '../finance/ledger';

@Injectable()
export class CalendarService {
  constructor(
    private readonly db: DatabaseService,
    private readonly scheduling: SchedulingService,
  ) {}
  get(q: { from: string; to: string }) {
    return this.db.transaction(async (c) => {
      await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const vehicles = (
        await c.query(
          'SELECT v.*,m.name AS model_name,b.name AS brand_name,p.name AS pricing_group_name FROM vehicles v JOIN vehicle_models m ON m.id=v.model_id JOIN vehicle_brands b ON b.id=m.brand_id JOIN pricing_groups p ON p.id=m.pricing_group_id WHERE v.archived_at IS NULL ORDER BY b.name,m.name,v.plate',
        )
      ).rows;
      const events = (
        await c.query(
          `SELECT s.*,c.display_name AS customer_name,c.phone AS customer_phone FROM schedule_blocks s LEFT JOIN bookings b ON b.id=s.booking_id LEFT JOIN customers c ON c.id=b.customer_id WHERE s.retired_at IS NULL AND s.start_at<$2 AND s.end_at>$1 ORDER BY s.start_at`,
          [q.from, q.to],
        )
      ).rows;
      const bookings = (
        await c.query(
          `SELECT b.*,c.display_name AS customer_name,c.phone AS customer_phone,s.vehicle_id,array(SELECT model_id FROM booking_eligible_models WHERE booking_id=b.id ORDER BY model_id) AS models FROM bookings b JOIN customers c ON c.id=b.customer_id LEFT JOIN schedule_blocks s ON s.booking_id=b.id AND s.retired_at IS NULL WHERE b.status='confirmed' AND b.start_at<$2 AND b.end_at>$1 ORDER BY b.start_at`,
          [q.from, q.to],
        )
      ).rows;
      const availabilityFacts = bookings.length
        ? await this.scheduling.loadAvailabilityFacts(c)
        : undefined;
      const inspect = await this.scheduling.createCalendarInspector(
        c,
        availabilityFacts,
        bookings.filter((b) => !b.vehicle_id).map((b) => b.id),
      );
      const problems = [];
      const financialSummaries = await bookingSummaries(
        c,
        bookings.map((b) => b.id),
      );
      for (const b of bookings) {
        b.financialSummary = financialSummaries.get(b.id);
        const inspection = await inspect({
          id: b.id,
          target: {
            type: b.target_type,
            id: b.target_vehicle_id ?? b.target_model_id ?? b.target_brand_id ?? b.target_group_id,
          },
          models: b.models,
          startAt: b.start_at.toISOString(),
          endAt: b.end_at.toISOString(),
          vehicleId: b.vehicle_id,
        });
        b.problemReasons = inspection.problemReasons;
        b.availability = inspection.availability;
        b.conflicts = inspection.conflicts;
        b.targetLabel = inspection.targetLabel;
        b.replacementReason = inspection.replacementReason;
        if (inspection.problemReasons.length || !b.vehicle_id)
          problems.push({ ...b, ...inspection });
      }
      const displaced = (
        await c.query(
          `SELECT DISTINCT ON (b.id) 'displaced-'||a.id AS id,(a.details->>'previousVehicleId')::int AS vehicle_id,b.id AS booking_id,'displaced' AS kind,b.start_at,b.end_at,c.display_name AS customer_name,c.phone AS customer_phone,a.details->>'reason' AS reason
              FROM bookings b JOIN customers c ON c.id=b.customer_id JOIN audit_logs a ON a.entity_type='booking' AND a.entity_id=b.id AND a.action='bookings.displaced'
              WHERE b.status='confirmed' AND b.start_at<$2 AND b.end_at>$1 AND NOT EXISTS(SELECT 1 FROM schedule_blocks s WHERE s.booking_id=b.id AND s.retired_at IS NULL)
              ORDER BY b.id,a.id DESC`,
          [q.from, q.to],
        )
      ).rows;
      return {
        vehicles,
        events: [...events, ...displaced].map((e) => ({
          ...e,
          financialSummary: bookings.find((b) => b.id === e.booking_id)?.financialSummary,
        })),
        bookings: bookings.map((b) => ({
          id: b.id,
          version: b.version,
          start_at: b.start_at,
          end_at: b.end_at,
          vehicle_id: b.vehicle_id,
          models: b.models,
        })),
        unassignedBookings: bookings.filter((b) => !b.vehicle_id),
        problems,
        evaluatedAt: new Date().toISOString(),
      };
    });
  }
}
