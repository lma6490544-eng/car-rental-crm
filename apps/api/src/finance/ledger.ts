import type { PoolClient } from 'pg';
import { audit, AuthRequest, fail } from '../platform/security';

export const MAX_RUB = 9223372036854775807n;
export const positive = (n: bigint) => (n > 0n ? n : 0n);
export function bounded(n: bigint) {
  if (n > MAX_RUB || n < -MAX_RUB)
    fail(422, 'MONEY_OVERFLOW', 'Сумма превышает допустимый предел.');
  return n;
}

export function rentPaymentProgress(summary: { priceRub: string; coverageRub: string }) {
  const price = BigInt(summary.priceRub);
  const received = BigInt(summary.coverageRub);
  const remaining = positive(price - received);
  let status: 'not_required' | 'paid' | 'partial' | 'unpaid';
  if (price === 0n) status = 'not_required';
  else if (remaining === 0n) status = 'paid';
  else status = received > 0n ? 'partial' : 'unpaid';
  return {
    status,
    priceRub: summary.priceRub,
    receivedRub: summary.coverageRub,
    remainingRub: remaining.toString(),
  };
}

export function rentPaidRatio(summary: { priceRub: string; coverageRub: string }) {
  const price = BigInt(summary.priceRub);
  const coverage = BigInt(summary.coverageRub);
  if (price === 0n || coverage >= price) return 1;
  if (coverage <= 0n) return 0;
  return Math.min(Number(coverage) / Number(price), 1 - Number.EPSILON);
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
  status: 'confirmed' | 'cancelled' | 'completed' | 'completed_early';
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

const chargeTotal = `coalesce((SELECT sum(f.amount_rub) FROM finance_charges f
  WHERE f.booking_id=b.id AND (b.status NOT IN ('completed','completed_early') OR EXISTS (
    SELECT 1 FROM financial_operations o WHERE o.id=f.operation_id
      AND split_part(o.command_id,':',1) IN ('rental-return','rental-damage')
  ))),0)::text AS price`;

function summaryAmounts(b: SummaryBooking, rows: readonly SummaryAllocation[]) {
  const amount = (bucket: string) => BigInt(rows.find((x) => x.bucket === bucket)?.amount ?? '0');
  const completed = b.status === 'completed' || b.status === 'completed_early';
  const price =
      BigInt(b.status === 'cancelled' ? '0' : (b.snapshot?.finalTotalRub ?? '0')) +
      (completed ? BigInt(b.price) : 0n),
    coverage = amount('rent'),
    deposit = amount('deposit');
  return { price, coverage, deposit };
}

export async function bookingSummary(c: PoolClient, bookingId: number) {
  const b = (
    await c.query<SummaryBooking>(
      `SELECT b.id,b.customer_id,b.version,b.status,(SELECT snapshot FROM booking_terms WHERE booking_id=b.id ORDER BY revision DESC LIMIT 1) AS snapshot,${chargeTotal}
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
        `SELECT coalesce(sum(a.amount_rub),0)::text AS amount FROM finance_allocations a JOIN finance_lots l ON l.id=a.lot_id WHERE l.customer_id=$1 AND a.bucket='credit' AND (a.available_at IS NULL OR a.available_at<=now())`,
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
      `SELECT b.id,b.customer_id,b.version,b.status,(SELECT snapshot FROM booking_terms WHERE booking_id=b.id ORDER BY revision DESC LIMIT 1) AS snapshot,${chargeTotal}
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
        `SELECT l.customer_id,coalesce(sum(a.amount_rub),0)::text AS amount FROM finance_allocations a JOIN finance_lots l ON l.id=a.lot_id WHERE l.customer_id=ANY($1::int[]) AND a.bucket='credit' AND (a.available_at IS NULL OR a.available_at<=now()) GROUP BY l.customer_id`,
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
    debtRub: b.status.startsWith('completed') ? positive(price - coverage).toString() : '0',
    overpaymentRub: positive(
      coverage - (b.status.startsWith('completed') ? price : BigInt(b.price)),
    ).toString(),
    depositRub: deposit.toString(),
    availableCreditRub: credit.toString(),
    suggestedDepositRub:
      category === 'minibus' ? '15000' : category === 'passenger' ? '10000' : null,
    paidPercent:
      price === 0n ? '100' : coverage >= price ? '100' : ((coverage * 100n) / price).toString(),
  };
}
export async function depositReserveReleaseAt(c: PoolClient, bookingId: number) {
  const { rows } = await c.query<{ releaseAt: Date | null }>(
    `SELECT ((returned_at AT TIME ZONE 'Europe/Moscow') + interval '21 days')
       AT TIME ZONE 'Europe/Moscow' AS "releaseAt"
     FROM booking_checkouts WHERE booking_id=$1`,
    [bookingId],
  );
  return rows[0]?.releaseAt ?? null;
}

// The caller holds the schedule lock shared with finance commands.
export async function rescheduleDepositReserve(
  c: PoolClient,
  bookingId: number,
  customerId: number,
) {
  const releaseAt = await depositReserveReleaseAt(c, bookingId);
  if (!releaseAt) return;
  const { rows: reserves } = await c.query<{
    operationId: number;
    lotId: number;
    fund: 'operating_cash' | 'deposit_pool' | null;
    availableAt: Date;
    released: boolean;
    amountRub: string;
  }>(
    `SELECT o.id AS "operationId",a.lot_id AS "lotId",a.fund,a.available_at AS "availableAt",
            a.available_at<=now() AS released,sum(a.amount_rub)::text AS "amountRub"
     FROM financial_operations o JOIN finance_allocations a ON a.operation_id=o.id
     WHERE o.booking_id=$1 AND a.bucket='credit' AND a.available_at IS NOT NULL
       AND o.reversal_of IS NULL
       AND NOT EXISTS (SELECT 1 FROM financial_operations r WHERE r.reversal_of=o.id)
     GROUP BY o.id,a.lot_id,a.fund,a.available_at
     HAVING sum(a.amount_rub)>0
     ORDER BY a.lot_id,a.available_at,o.id`,
    [bookingId],
  );
  if (!reserves.length) return;
  const available = new Map(
    (await sources(c, customerId))
      .filter((source) => source.bucket === 'credit' && source.bookingId === null)
      .map(({ lotId, fund, availableRub }) => [`${lotId}:${fund}`, BigInt(availableRub)]),
  );
  for (const reserve of reserves) {
    let amount = BigInt(reserve.amountRub);
    if (reserve.released) {
      const key = `${reserve.lotId}:${reserve.fund}`;
      const remaining = available.get(key) ?? 0n;
      if (amount > remaining) amount = remaining;
      available.set(key, remaining - amount);
    }
    if (amount === 0n || reserve.availableAt.getTime() === releaseAt.getTime()) continue;
    // Append equal and opposite entries to the settlement so its reversal still covers both dates.
    await c.query(
      `INSERT INTO finance_allocations(operation_id,lot_id,bucket,amount_rub,fund,available_at)
         VALUES($1,$2,'credit',-$3::bigint,$4,$5),($1,$2,'credit',$3::bigint,$4,$6)`,
      [
        reserve.operationId,
        reserve.lotId,
        bounded(amount).toString(),
        reserve.fund,
        reserve.availableAt,
        releaseAt,
      ],
    );
  }
}

export async function depositReserve(c: PoolClient, bookingId: number) {
  const { rows } = await c.query<{ amountRub: string; releaseAt: Date }>(
    `SELECT sum(a.amount_rub)::text AS "amountRub", a.available_at AS "releaseAt"
     FROM finance_allocations a JOIN financial_operations o ON o.id=a.operation_id
     WHERE o.booking_id=$1 AND a.available_at>now()
     GROUP BY a.available_at HAVING sum(a.amount_rub)>0 ORDER BY a.available_at`,
    [bookingId],
  );
  return rows;
}

export async function sources(c: PoolClient, customerId: number) {
  return (
    await c.query<{
      lotId: number;
      originalOperationId: number;
      origin: 'rent' | 'deposit';
      method: 'cash' | 'bank';
      bucket: SummaryAllocation['bucket'];
      fund: 'operating_cash' | 'deposit_pool' | null;
      bookingId: number | null;
      availableRub: string;
    }>(
      `SELECT l.id AS "lotId",l.original_operation_id AS "originalOperationId",l.origin,l.method,a.bucket,a.fund,a.booking_id AS "bookingId",sum(a.amount_rub)::text AS "availableRub"
    FROM finance_lots l JOIN finance_allocations a ON a.lot_id=l.id WHERE l.customer_id=$1 AND (a.available_at IS NULL OR a.available_at<=now()) GROUP BY l.id,a.bucket,a.booking_id,a.fund HAVING sum(a.amount_rub)>0 ORDER BY l.id,a.bucket,a.booking_id,a.fund`,
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
