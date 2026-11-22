import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database.service';
import { SchedulingService } from './scheduling.service';
import type { Target } from './scheduling.service';
import type { BookingRow } from './booking-write';
import { bookingSummaries, rentPaymentProgress } from '../finance/ledger';
import { checkoutPhases } from '../documents/checkout-state';
import { accountingEmailKind } from './accounting-email';

type CalendarBookingRow = Omit<BookingRow, 'status' | 'target_type'> & {
  status: 'confirmed';
  target_type: Target['type'];
  customer_name: string;
  customer_phone: string;
  vehicle_id: number | null;
  models: number[];
  customer_is_company: boolean;
  accounting_email_unsent: boolean;
};

type CalendarEventRow = {
  id: number;
  vehicle_id: number;
  booking_id: number | null;
  kind: 'assignment' | 'technical';
  start_at: Date;
  end_at: Date;
  reason: string;
  retired_at: Date | null;
  version: number;
  created_by: number;
  created_at: Date;
  customer_name: string | null;
  customer_phone: string | null;
};

type DisplacedEventRow = Pick<CalendarEventRow, 'start_at' | 'end_at'> & {
  id: string;
  booking_id: number;
  vehicle_id: number | null;
  kind: 'displaced';
  customer_name: string;
  customer_phone: string;
  reason: string | null;
};

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
        await c.query<CalendarEventRow>(
          `SELECT s.*,c.display_name AS customer_name,c.phone AS customer_phone FROM schedule_blocks s LEFT JOIN bookings b ON b.id=s.booking_id LEFT JOIN customers c ON c.id=b.customer_id WHERE s.retired_at IS NULL AND s.start_at<$2 AND s.end_at>$1 ORDER BY s.start_at`,
          [q.from, q.to],
        )
      ).rows;
      const accountingEmailUnsent = new Set<number>();
      const companyBookingIds = new Set<number>();
      const bookings = (
        await c.query<CalendarBookingRow>(
          `SELECT b.id,b.customer_id,b.status,b.version,b.start_at,b.end_at,b.target_type,
            b.target_vehicle_id,b.target_model_id,b.target_brand_id,b.target_group_id,
            b.created_by,b.created_at,b.updated_at,
            c.display_name AS customer_name,c.phone AS customer_phone,s.vehicle_id,
            array(SELECT model_id FROM booking_eligible_models WHERE booking_id=b.id ORDER BY model_id) AS models,
            c.type='company' AS customer_is_company,
            c.type='company' AND mail.id IS NULL AS accounting_email_unsent
          FROM bookings b JOIN customers c ON c.id=b.customer_id
          LEFT JOIN schedule_blocks s ON s.booking_id=b.id AND s.retired_at IS NULL
          LEFT JOIN outbox_jobs mail ON mail.business_key=$3 || ':' || b.id AND mail.kind=$3 AND mail.status='done'
          WHERE b.status='confirmed' AND b.start_at<$2 AND b.end_at>$1 ORDER BY b.start_at`,
          [q.from, q.to, accountingEmailKind],
        )
      ).rows.map(
        ({ accounting_email_unsent: unsent, customer_is_company: isCompany, ...booking }) => {
          if (unsent) accountingEmailUnsent.add(booking.id);
          if (isCompany) companyBookingIds.add(booking.id);
          return booking;
        },
      );
      const availabilityFacts = bookings.length
        ? await this.scheduling.loadAvailabilityFacts(c)
        : undefined;
      const inspect = await this.scheduling.createCalendarInspector(
        c,
        availabilityFacts,
        bookings.filter((b) => !b.vehicle_id).map((b) => b.id),
      );
      const financialSummaries = await bookingSummaries(
        c,
        bookings.map((b) => b.id),
      );
      type CalendarBooking = (typeof bookings)[number];
      type Inspection = Awaited<ReturnType<typeof inspect>>;
      type EnrichedBooking = CalendarBooking &
        Pick<
          Inspection,
          'problemReasons' | 'availability' | 'conflicts' | 'targetLabel' | 'replacementReason'
        > & {
          financialSummary: ReturnType<typeof financialSummaries.get>;
        };
      const unassigned: EnrichedBooking[] = [];
      const problems: (EnrichedBooking & Inspection)[] = [];
      const invoicePayments = new Map<number, ReturnType<typeof rentPaymentProgress>>();
      for (const b of bookings) {
        const summary = financialSummaries.get(b.id);
        if (summary && companyBookingIds.has(b.id))
          invoicePayments.set(b.id, rentPaymentProgress(summary));
        const inspection = await inspect({
          id: b.id,
          target: {
            type: b.target_type,
            id: (b.target_vehicle_id ??
              b.target_model_id ??
              b.target_brand_id ??
              b.target_group_id)!,
          },
          models: b.models,
          startAt: b.start_at.toISOString(),
          endAt: b.end_at.toISOString(),
          vehicleId: b.vehicle_id,
        });
        const enriched = {
          ...b,
          financialSummary: summary,
          problemReasons: inspection.problemReasons,
          availability: inspection.availability,
          conflicts: inspection.conflicts,
          targetLabel: inspection.targetLabel,
          replacementReason: inspection.replacementReason,
        };
        if (b.vehicle_id === null) unassigned.push(enriched);
        if (inspection.problemReasons.length || !b.vehicle_id)
          problems.push({ ...enriched, ...inspection });
      }
      const displaced = (
        await c.query<DisplacedEventRow>(
          `SELECT DISTINCT ON (b.id) 'displaced-'||a.id AS id,(a.details->>'previousVehicleId')::int AS vehicle_id,b.id AS booking_id,'displaced' AS kind,b.start_at,b.end_at,c.display_name AS customer_name,c.phone AS customer_phone,a.details->>'reason' AS reason
              FROM bookings b JOIN customers c ON c.id=b.customer_id JOIN audit_logs a ON a.entity_type='booking' AND a.entity_id=b.id AND a.action='bookings.displaced'
              WHERE b.status='confirmed' AND b.start_at<$2 AND b.end_at>$1 AND NOT EXISTS(SELECT 1 FROM schedule_blocks s WHERE s.booking_id=b.id AND s.retired_at IS NULL)
              ORDER BY b.id,a.id DESC`,
          [q.from, q.to],
        )
      ).rows;
      const phases = await checkoutPhases(
        c,
        bookings.map((b) => b.id),
      );
      return {
        vehicles,
        events: [...events, ...displaced].map((event) => {
          const bookingId = event.booking_id;
          if (bookingId === null) return event;
          return {
            ...event,
            checkoutPhase: phases.get(bookingId),
            ...(accountingEmailUnsent.has(bookingId) ? { accountingEmailUnsent: true } : {}),
            invoicePayment: invoicePayments.get(bookingId),
            financialSummary: financialSummaries.get(bookingId),
          };
        }),
        bookings: bookings.map((b) => ({
          id: b.id,
          version: b.version,
          start_at: b.start_at,
          end_at: b.end_at,
          vehicle_id: b.vehicle_id,
          models: b.models,
        })),
        unassignedBookings: unassigned.map((b) => ({
          ...b,
          checkoutPhase: phases.get(b.id),
          ...(accountingEmailUnsent.has(b.id) ? { accountingEmailUnsent: true } : {}),
          ...(invoicePayments.has(b.id) ? { invoicePayment: invoicePayments.get(b.id) } : {}),
        })),
        problems,
        evaluatedAt: new Date().toISOString(),
      };
    });
  }
}
