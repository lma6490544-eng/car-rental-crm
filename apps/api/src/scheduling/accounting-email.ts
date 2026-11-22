import type { Pool, PoolClient } from 'pg';
import type { Calculation } from '../pricing/calculate';

export const accountingEmailKind = 'booking.accounting-email';

export async function queueAccountingEmail(client: PoolClient, bookingId: number) {
  const result = await client.query(
    `INSERT INTO outbox_jobs(business_key, kind, payload)
    SELECT $2 || ':' || b.id, $2, jsonb_build_object('bookingId', b.id, 'assignmentId', s.id)
    FROM bookings b JOIN customers c ON c.id=b.customer_id
    JOIN schedule_blocks s ON s.booking_id=b.id AND s.kind='assignment' AND s.retired_at IS NULL
    WHERE b.id=$1 AND b.status='confirmed' AND c.type='company'
    ON CONFLICT (business_key) DO UPDATE SET payload=EXCLUDED.payload,status='pending',
      attempts=0,next_attempt_at=now(),lease_until=NULL
    WHERE outbox_jobs.status='failed' OR (
      outbox_jobs.status='pending' AND
      (outbox_jobs.payload->>'assignmentId') IS DISTINCT FROM (EXCLUDED.payload->>'assignmentId')
    )`,
    [bookingId, accountingEmailKind],
  );
  return result.rowCount === 1;
}

type AccountingEmailStatus =
  'none' | 'pending' | 'running' | 'done' | 'failed' | 'unknown' | 'cancelled';

export async function getAccountingEmailStatus(pool: Pool, bookingId: number) {
  // The previous worker set next_attempt_at to the successful completion time plus one minute.
  const { rows } = await pool.query<{
    status: AccountingEmailStatus;
    can_request: boolean;
    is_company: boolean;
    sent_at: Date | null;
  }>(
    `SELECT availability.status,c.type='company' AS is_company,
      CASE WHEN j.status='done' THEN
        coalesce((j.payload->>'sentAt')::timestamptz,j.next_attempt_at-interval '1 minute')
      END AS sent_at,
      (b.status='confirmed' AND c.type='company' AND s.id IS NOT NULL
        AND availability.status IN ('none','failed')) AS can_request
    FROM bookings b JOIN customers c ON c.id=b.customer_id
    LEFT JOIN schedule_blocks s ON s.booking_id=b.id AND s.kind='assignment' AND s.retired_at IS NULL
    LEFT JOIN outbox_jobs j ON j.business_key=$2 || ':' || b.id AND j.kind=$2
    CROSS JOIN LATERAL (
      SELECT CASE
        WHEN b.status='cancelled' AND j.status='pending' THEN 'cancelled'
        WHEN j.status='pending' AND (s.id IS NULL OR (j.payload->>'assignmentId') IS DISTINCT FROM s.id::text) THEN 'none'
        ELSE coalesce(j.status,'none')
      END AS status
    ) availability
    WHERE b.id=$1`,
    [bookingId, accountingEmailKind],
  );
  const status = rows[0];
  return {
    status: status?.status ?? 'none',
    canRequest: status?.can_request ?? false,
    isCompany: status?.is_company ?? false,
    sentAt: status?.sent_at?.toISOString() ?? null,
  };
}

type InvoiceCalculation = Pick<Calculation, 'finalTotalRub'> &
  Partial<Pick<Calculation, 'dayLines' | 'contractDays'>>;

export type AccountingBooking = {
  bookingId: number;
  company: string;
  startAt: Date;
  endAt: Date;
  brand: string;
  model: string;
  plate: string;
  calculation: InvoiceCalculation;
};

const dateFormat = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  day: '2-digit',
  month: '2-digit',
});
const yearFormat = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', year: 'numeric' });
const rubles = new Intl.NumberFormat('ru-RU');
const dayPlural = new Intl.PluralRules('ru-RU');

function daysLabel(days: number) {
  const plural = dayPlural.select(days);
  if (plural === 'one') return `${days} день`;
  if (plural === 'few') return `${days} дня`;
  return `${days} дней`;
}

function displayName(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

export function accountingMessage(booking: AccountingBooking) {
  const { bookingId, startAt, endAt, calculation } = booking;
  const total = BigInt(calculation.finalTotalRub);
  const rates = new Map<bigint, number>();
  for (const day of calculation.dayLines ?? []) {
    if (day.nonBillable) continue;
    const amount = BigInt(day.amountRub);
    rates.set(amount, (rates.get(amount) ?? 0) + 1);
  }
  const rateLines = [...rates].map(
    ([rate, days]) => `${daysLabel(days)} по ${rubles.format(rate)} ₽`,
  );
  const rateTotal = [...rates].reduce((sum, [rate, days]) => sum + rate * BigInt(days), 0n);
  const totalLine = `${rubles.format(total)} ₽`;
  const term = rateLines.length
    ? `${rateLines.join(' + ')}${rateTotal === total ? ' = ' : ', итого '}${totalLine}`
    : `${calculation.contractDays ? daysLabel(calculation.contractDays) + ', ' : ''}итого ${totalLine}`;
  const startYear = yearFormat.format(startAt);
  const endYear = yearFormat.format(endAt);
  const start = dateFormat.format(startAt) + (startYear === endYear ? '' : `.${startYear}`);
  const end = dateFormat.format(endAt) + (startYear === endYear ? '' : `.${endYear}`);
  const model = displayName(booking.model);
  const brand = displayName(booking.brand);
  const car = model.toLowerCase().startsWith(brand.toLowerCase() + ' ')
    ? model
    : `${brand} ${model}`;
  return {
    subject: `Данные для счёта по брони №${bookingId}`,
    text: `${displayName(booking.company)} с ${start} по ${end} ${term}\nАвтомобиль: ${car}, гос. № ${displayName(booking.plate)}`,
  };
}
