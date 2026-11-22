import type { PoolClient } from 'pg';
import { fail } from '../platform/security';

export type BookingDocumentContext = {
  customerId: number;
  status: 'confirmed' | 'cancelled';
  version: number;
  vehicleId: number | null;
};

export async function bookingContext(c: PoolClient, bookingId: number, locked: boolean) {
  const booking = (
    await c.query<Omit<BookingDocumentContext, 'vehicleId'>>(
      'SELECT customer_id AS "customerId", status, version FROM bookings WHERE id=$1' +
        (locked ? ' FOR UPDATE' : ''),
      [bookingId],
    )
  ).rows[0];
  if (!booking) fail(404, 'NOT_FOUND', 'Бронь не найдена.');
  const assignment = (
    await c.query<{ vehicle_id: number }>(
      'SELECT vehicle_id FROM schedule_blocks WHERE booking_id=$1 AND retired_at IS NULL',
      [bookingId],
    )
  ).rows[0];
  return { ...booking, vehicleId: assignment?.vehicle_id ?? null };
}

export async function lockConfirmedBooking(c: PoolClient, bookingId: number, expected?: number) {
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended('crm:schedule',0))");
  const booking = await bookingContext(c, bookingId, true);
  if (expected !== undefined && booking.version !== expected)
    fail(409, 'BOOKING_VERSION_CONFLICT', 'Бронь изменилась. Сверьте актуальные данные.');
  if (booking.status !== 'confirmed') fail(422, 'BOOKING_CANCELLED', 'Бронь отменена.');
  return booking;
}

export async function lockBooking(c: PoolClient, bookingId: number, expected?: number) {
  const booking = await lockConfirmedBooking(c, bookingId, expected);
  if (booking.vehicleId === null)
    fail(422, 'VEHICLE_REQUIRED', 'Назначьте автомобиль в карточке брони.');
  return { ...booking, vehicleId: booking.vehicleId };
}

export type VehicleSnapshot = {
  vin: string | null;
  brand: string;
  model: string;
  plate: string;
  year: number;
  bodyType: string;
  currentMileageKm: number | null;
  nextMaintenanceDueKm: number | null;
  tankLiters: number;
  hasCasco?: boolean | null;
};

export async function vehicleSnapshot(c: PoolClient, id: number, locked = true) {
  const vehicle = (
    await c.query<VehicleSnapshot>(
      `SELECT v.vin, b.name AS brand, m.name AS model, v.plate, v.year,
       (to_jsonb(v)->>'has_casco')::boolean AS "hasCasco", v.body_type AS "bodyType", v.current_mileage_km AS "currentMileageKm",
       v.next_maintenance_due_km AS "nextMaintenanceDueKm",
       CASE v.body_type WHEN 'cargo_minibus' THEN 80 ELSE 40 END AS "tankLiters"
     FROM vehicles v JOIN vehicle_models m ON m.id=v.model_id
     JOIN vehicle_brands b ON b.id=m.brand_id WHERE v.id=$1 AND v.archived_at IS NULL
     ${locked ? 'FOR SHARE OF v,m,b' : ''}`,
      [id],
    )
  ).rows[0];
  if (!vehicle) fail(422, 'VEHICLE_REQUIRED', 'Назначьте действующий автомобиль.');
  return vehicle;
}
