import type { PoolClient } from 'pg';
import { audit, AuthRequest, fail } from '../platform/security';

export const MAX_RUB = 9223372036854775807n;
export const positive = (n: bigint) => (n > 0n ? n : 0n);
export function bounded(n: bigint) {
  if (n > MAX_RUB || n < -MAX_RUB)
    fail(422, 'MONEY_OVERFLOW', 'Сумма превышает допустимый предел.');
  return n;
}

export async function recordEvent(
  c: PoolClient,
  r: AuthRequest,
  id: number,
  kind: string,
  bookingId?: number | null,
  details: Record<string, unknown> = {},
) {
  await audit(c, r.auth!.user.id, 'financial_operation', 'finance.' + kind, id, r.requestId, {
    bookingId,
    ...details,
  });
  await c.query('INSERT INTO outbox_jobs(business_key,kind,payload) VALUES ($1,$2,$3)', [
    'finance:' + id,
    'finance.posted',
    JSON.stringify({ id, bookingId }),
  ]);
}

type SummaryBooking = {
  id: number;
  customer_id: number;
  version: number;
  status: 'confirmed' | 'cancelled';
  snapshot: {
    finalTotalRub?: string | null;
    periods?: {
      pricingGroup?: { code?: string };
      tariffSnapshot?: { groups?: { code: string; category?: string }[] };
    }[];
  } | null;
  price: string;
};
type SummaryAllocation = { bucket: 'rent' | 'deposit' | 'credit'; amount: string };

function summaryAmounts(b: SummaryBooking, rows: readonly SummaryAllocation[]) {
  const amount = (bucket: string) => BigInt(rows.find((x) => x.bucket === bucket)?.amount ?? '0');
  const price = BigInt(b.status === 'cancelled' ? '0' : (b.snapshot?.finalTotalRub ?? '0')),
    coverage = amount('rent'),
    deposit = amount('deposit');
  return { price, coverage, deposit };
}

export async function bookingSummary(c: PoolClient, bookingId: number) {
  const b = (
    await c.query<SummaryBooking>(
      `SELECT b.id,b.customer_id,b.version,b.status,(SELECT snapshot FROM booking_terms WHERE booking_id=b.id ORDER BY revision DESC LIMIT 1) AS snapshot,coalesce((SELECT sum(amount_rub) FROM finance_charges WHERE booking_id=b.id),0)::text AS price
    FROM bookings b WHERE b.id=$1`,
      [bookingId],
    )
  ).rows[0];
  if (!b) fail(404, 'NOT_FOUND', 'Бронь не найдена.');
  const rows = (
    await c.query<SummaryAllocation>(
      `SELECT bucket,coalesce(sum(amount_rub),0)::text AS amount FROM finance_allocations WHERE booking_id=$1 GROUP BY bucket`,
      [bookingId],
    )
  ).rows;
  const amounts = summaryAmounts(b, rows);
  const credit = BigInt(
    (
      await c.query<{ amount: string }>(
        `SELECT coalesce(sum(a.amount_rub),0)::text AS amount FROM finance_allocations a JOIN finance_lots l ON l.id=a.lot_id WHERE l.customer_id=$1 AND a.bucket='credit'`,
        [b.customer_id],
      )
    ).rows[0].amount,
  );
  return summaryResult(bookingId, b, amounts, credit);
}

// Calendar calls this with its existing PoolClient and REPEATABLE READ snapshot.
export async function bookingSummaries(c: PoolClient, bookingIds: readonly number[]) {
  const summaries = new Map<number, ReturnType<typeof summaryResult>>();
  if (!bookingIds.length) return summaries;
  const ids = [...new Set(bookingIds)];
  const bookings = (
    await c.query<SummaryBooking>(
      `SELECT b.id,b.customer_id,b.version,b.status,(SELECT snapshot FROM booking_terms WHERE booking_id=b.id ORDER BY revision DESC LIMIT 1) AS snapshot,coalesce((SELECT sum(amount_rub) FROM finance_charges WHERE booking_id=b.id),0)::text AS price
    FROM bookings b WHERE b.id=ANY($1::int[])`,
      [ids],
    )
  ).rows;
  if (bookings.length !== ids.length) fail(404, 'NOT_FOUND', 'Бронь не найдена.');
  const rows = (
    await c.query<SummaryAllocation & { booking_id: number }>(
      `SELECT booking_id,bucket,coalesce(sum(amount_rub),0)::text AS amount FROM finance_allocations WHERE booking_id=ANY($1::int[]) GROUP BY booking_id,bucket`,
      [ids],
    )
  ).rows;
  const allocations = new Map<number, SummaryAllocation[]>();
  for (const row of rows) {
    const bucketRows = allocations.get(row.booking_id) ?? [];
    bucketRows.push(row);
    allocations.set(row.booking_id, bucketRows);
  }
  const customerIds = [...new Set(bookings.map((b) => b.customer_id))];
  const credits = new Map(
    (
      await c.query<{ customer_id: number; amount: string }>(
        `SELECT l.customer_id,coalesce(sum(a.amount_rub),0)::text AS amount FROM finance_allocations a JOIN finance_lots l ON l.id=a.lot_id WHERE l.customer_id=ANY($1::int[]) AND a.bucket='credit' GROUP BY l.customer_id`,
        [customerIds],
      )
    ).rows.map((row) => [row.customer_id, row.amount]),
  );
  for (const b of bookings) {
    const amounts = summaryAmounts(b, allocations.get(b.id) ?? []);
    summaries.set(b.id, summaryResult(b.id, b, amounts, BigInt(credits.get(b.customer_id) ?? '0')));
  }
  return summaries;
}

function summaryResult(
  bookingId: number,
  b: SummaryBooking,
  { price, coverage, deposit }: ReturnType<typeof summaryAmounts>,
  credit: bigint,
) {
  const period = b.snapshot?.periods?.[0];
  const category = period?.tariffSnapshot?.groups?.find(
    (g) => g.code === period.pricingGroup?.code,
  )?.category;
  return {
    bookingId,
    customerId: b.customer_id,
    bookingVersion: b.version,
    status: b.status,
    paymentsAllowed: false,
    priceRub: price.toString(),
    coverageRub: coverage.toString(),
    debtRub: '0',
    overpaymentRub: positive(coverage - BigInt(b.price)).toString(),
    depositRub: deposit.toString(),
    availableCreditRub: credit.toString(),
    suggestedDepositRub:
      category === 'minibus' ? '15000' : category === 'passenger' ? '10000' : null,
    paidPercent:
      price === 0n ? '100' : coverage >= price ? '100' : ((coverage * 100n) / price).toString(),
  };
}
export async function sources(c: PoolClient, customerId: number) {
  return (
    await c.query(
      `SELECT l.id AS "lotId",l.original_operation_id AS "originalOperationId",l.origin,l.method,a.bucket,a.fund,a.booking_id AS "bookingId",sum(a.amount_rub)::text AS "availableRub"
    FROM finance_lots l JOIN finance_allocations a ON a.lot_id=l.id WHERE l.customer_id=$1 GROUP BY l.id,a.bucket,a.booking_id,a.fund HAVING sum(a.amount_rub)>0 ORDER BY l.id,a.bucket,a.booking_id,a.fund`,
      [customerId],
    )
  ).rows;
}
export async function funds(c: PoolClient) {
  const rows = (
    await c.query(`SELECT f.id,f.version,coalesce(sum(e.amount_rub),0)::text AS "balanceRub",bool_or(e.is_initial) IS TRUE AS initialized,count(e.id)>0 AS "hasEntries"
    FROM finance_funds f LEFT JOIN finance_fund_entries e ON e.fund=f.id GROUP BY f.id ORDER BY f.id`)
  ).rows;
  const obligations = BigInt(
    (
      await c.query<{ amount: string }>(
        `SELECT coalesce(sum(amount_rub),0)::text AS amount FROM finance_allocations WHERE fund='deposit_pool' AND bucket IN ('deposit','credit')`,
      )
    ).rows[0].amount,
  );
  const initialAllowed = !(
    await c.query(
      "SELECT 1 FROM financial_operations WHERE kind NOT IN ('charge','initial') LIMIT 1",
    )
  ).rowCount;
  return {
    items: rows,
    initialAllowed,
    depositObligationRub: obligations.toString(),
    depositShortfallRub: positive(
      obligations - BigInt(rows.find((x) => x.id === 'deposit_pool').balanceRub),
    ).toString(),
  };
}
