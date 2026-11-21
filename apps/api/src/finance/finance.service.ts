import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database.service';
import { CommandsService } from '../platform/commands.service';
import { AuthRequest, fail, hash } from '../platform/security';
import { scheduleLock } from '../scheduling/scheduling.service';
import type { FinanceInput } from './finance.dto';
import { bookingSummary, bounded, funds, recordEvent, sources } from './ledger';

export { financeInput } from './finance.dto';
export type { FinanceInput } from './finance.dto';
type AllocationBucket = 'rent' | 'deposit' | 'credit';
type FundId = 'operating_cash' | 'deposit_pool';
type PaymentMethod = 'cash' | 'bank';

type Allocation = {
  lotId: number;
  bucket: AllocationBucket;
  fund: FundId | null;
  bookingId: number | null;
  amount: bigint;
};
type Plan = {
  allocations: Allocation[];
  funds: Record<string, bigint>;
  external: { method: PaymentMethod; amount: bigint }[];
  customerId: number | null | undefined;
  bookingId: number | null | undefined;
  newLot?: { origin: 'rent' | 'deposit'; method: PaymentMethod };
  reversalOf?: number;
};

type OperationContextRow = { booking_id: number | null; customer_id: number | null };
type OperationRow = OperationContextRow & {
  id: number;
  command_id: string;
  request_hash: string;
  kind: FinanceInput['kind'] | 'charge';
  actor_id: number | null;
  reason: string;
  // pg also decodes PostgreSQL timestamp infinities as numbers.
  created_at: Date | number;
  reversal_of: number | null;
};
type AllocationRow = {
  id: number;
  operation_id: number;
  lot_id: number;
  bucket: AllocationBucket;
  booking_id: number | null;
  amount_rub: string;
  fund: FundId | null;
};
type FundEntryRow = {
  id: number;
  operation_id: number;
  fund: FundId;
  amount_rub: string;
  is_initial: boolean;
};
type ExternalRow = {
  id: number;
  operation_id: number;
  method: PaymentMethod;
  amount_rub: string;
};

type JournalRow = OperationRow & {
  author: string | null;
  customer_name: string | null;
  funds: { fund: FundId; amountRub: string; initial: boolean }[];
  external: { method: PaymentMethod; amountRub: string }[];
  allocations: {
    lotId: number;
    bucket: AllocationBucket;
    bookingId: number | null;
    amountRub: string;
  }[];
  chargeRub: string | null;
  reversedBy: number | null;
};

@Injectable()
export class FinanceService {
  constructor(
    readonly db: DatabaseService,
    readonly commands: CommandsService,
  ) {}
  async journal(c: PoolClient, customerId?: number, bookingId?: number) {
    return {
      items: (
        await c.query<JournalRow>(
          `SELECT o.*,u.full_name AS author,c.display_name AS customer_name,
     coalesce((SELECT jsonb_agg(jsonb_build_object('fund',e.fund,'amountRub',e.amount_rub::text,'initial',e.is_initial) ORDER BY e.id) FROM finance_fund_entries e WHERE e.operation_id=o.id),'[]') AS funds,
     coalesce((SELECT jsonb_agg(jsonb_build_object('method',e.method,'amountRub',e.amount_rub::text) ORDER BY e.id) FROM finance_external e WHERE e.operation_id=o.id),'[]') AS external,
     coalesce((SELECT jsonb_agg(jsonb_build_object('lotId',a.lot_id,'bucket',a.bucket,'bookingId',a.booking_id,'amountRub',a.amount_rub::text) ORDER BY a.id) FROM finance_allocations a WHERE a.operation_id=o.id),'[]') AS allocations,
     (SELECT amount_rub::text FROM finance_charges WHERE operation_id=o.id) AS "chargeRub",
     (SELECT id FROM financial_operations WHERE reversal_of=o.id) AS "reversedBy"
     FROM financial_operations o LEFT JOIN users u ON u.id=o.actor_id LEFT JOIN customers c ON c.id=o.customer_id
     WHERE EXISTS (SELECT 1 FROM finance_external e WHERE e.operation_id=o.id AND e.amount_rub<>0)
       AND ($1::int IS NULL OR o.customer_id=$1) AND ($2::int IS NULL OR o.booking_id=$2)
     ORDER BY o.id DESC LIMIT 200`,
          [customerId ?? null, bookingId ?? null],
        )
      ).rows,
    };
  }
  async customer(c: PoolClient, id: number) {
    if (!(await c.query<{ id: number }>('SELECT id FROM customers WHERE id=$1', [id])).rowCount)
      fail(404, 'NOT_FOUND', 'Клиент не найден.');
    const bookings = (
      await c.query<{ id: number }>(
        'SELECT id FROM bookings WHERE customer_id=$1 ORDER BY id DESC',
        [id],
      )
    ).rows;
    const summaries = [];
    for (const b of bookings) summaries.push(await bookingSummary(c, b.id));
    return { sources: await sources(c, id), bookings: summaries, ...(await this.journal(c, id)) };
  }
  async lock(c: PoolClient, input: FinanceInput) {
    // Shared schedule lock also serializes price changes, cancellation and displacement.
    // Domain order matches Scheduling: schedule, booking, customer, lots, funds.
    await scheduleLock(c);
    let bookingId: number | null | undefined = 'bookingId' in input ? input.bookingId : undefined,
      customerId: number | null | undefined = 'customerId' in input ? input.customerId : undefined;
    if (input.kind === 'reversal') {
      const old = (
        await c.query<OperationContextRow>(
          'SELECT booking_id,customer_id FROM financial_operations WHERE id=$1',
          [input.operationId],
        )
      ).rows[0];
      bookingId = old?.booking_id;
      customerId = old?.customer_id;
    }
    if (bookingId) await c.query('SELECT id FROM bookings WHERE id=$1 FOR UPDATE', [bookingId]);
    if (customerId) {
      await c.query('SELECT id FROM customers WHERE id=$1 FOR UPDATE', [customerId]);
      await c.query('SELECT id FROM finance_lots WHERE customer_id=$1 ORDER BY id FOR UPDATE', [
        customerId,
      ]);
    }
    await c.query('SELECT id FROM finance_funds ORDER BY id FOR UPDATE');
  }
  async plan(c: PoolClient, input: FinanceInput): Promise<Plan> {
    const p: Plan = {
      allocations: [],
      funds: {},
      external: [],
      customerId: 'customerId' in input ? input.customerId : undefined,
      bookingId: 'bookingId' in input ? input.bookingId : undefined,
    };
    const fund = (name: string, n: bigint) => {
      p.funds[name] = bounded((p.funds[name] ?? 0n) + n);
    };
    let summary;
    if (p.bookingId) {
      summary = await bookingSummary(c, p.bookingId);
      if (summary.customerId !== p.customerId)
        fail(422, 'CUSTOMER_MISMATCH', 'Бронь принадлежит другому клиенту.');
      if (!('expectedVersion' in input) || input.expectedVersion !== summary.bookingVersion)
        fail(
          409,
          'BOOKING_VERSION_CONFLICT',
          'Условия брони изменились. Обновите данные перед подтверждением.',
        );
    }
    // Booking confirmation is not a signed contract or actual vehicle handover.
    // No issuance workflow exists yet; never infer eligibility from booking status/date.
    if (['rent_payment', 'deposit_receipt', 'credit_use'].includes(input.kind))
      fail(
        422,
        'RENTAL_NOT_ISSUED',
        'Оплата, залог и зачёт в оплату доступны только при оформлении договора и фактической выдаче автомобиля. Оформление выдачи пока недоступно.',
      );
    if (input.kind === 'initial') {
      const state = await funds(c),
        f = state.items.find((x) => x.id === input.fund);
      if (
        f.hasEntries ||
        (
          await c.query(
            "SELECT 1 FROM financial_operations WHERE kind NOT IN ('charge','initial') LIMIT 1",
          )
        ).rowCount
      )
        fail(
          422,
          'INITIAL_LOCKED',
          'Начальное сальдо вводится один раз до рабочих денежных операций.',
        );
      fund(input.fund, BigInt(input.amountRub));
      return p;
    }
    if (input.kind === 'reversal') {
      const old = (
        await c.query<OperationRow>('SELECT * FROM financial_operations WHERE id=$1', [
          input.operationId,
        ])
      ).rows[0];
      if (!old || ['charge', 'initial', 'reversal'].includes(old.kind))
        fail(422, 'REVERSAL_NOT_ALLOWED', 'Эту операцию нельзя отменить денежной компенсацией.');
      if (
        (await c.query('SELECT id FROM financial_operations WHERE reversal_of=$1', [old.id]))
          .rowCount
      )
        fail(409, 'ALREADY_REVERSED', 'Операция уже компенсирована.');
      p.customerId = old.customer_id;
      p.bookingId = old.booking_id;
      p.reversalOf = old.id;
      p.allocations = (
        await c.query<AllocationRow>(
          'SELECT * FROM finance_allocations WHERE operation_id=$1 ORDER BY id',
          [old.id],
        )
      ).rows.map((a) => ({
        lotId: a.lot_id,
        bucket: a.bucket,
        fund: a.fund,
        bookingId: a.booking_id,
        amount: -BigInt(a.amount_rub),
      }));
      for (const f of (
        await c.query<FundEntryRow>('SELECT * FROM finance_fund_entries WHERE operation_id=$1', [
          old.id,
        ])
      ).rows)
        fund(f.fund, -BigInt(f.amount_rub));
      p.external = (
        await c.query<ExternalRow>('SELECT * FROM finance_external WHERE operation_id=$1', [old.id])
      ).rows.map((e) => ({ method: e.method, amount: -BigInt(e.amount_rub) }));
    } else if (input.kind === 'rent_payment' || input.kind === 'deposit_receipt') {
      if (summary!.status !== 'confirmed')
        fail(
          422,
          'BOOKING_CANCELLED',
          'Новая оплата отменённой брони недоступна. Возврат и зачёт остатка доступны отдельно.',
        );
      const n = BigInt(input.amountRub),
        origin = input.kind === 'rent_payment' ? 'rent' : 'deposit';
      p.newLot = { origin, method: input.method };
      p.allocations.push({
        lotId: 0,
        bucket: origin,
        fund:
          input.method === 'bank' ? null : origin === 'rent' ? 'operating_cash' : 'deposit_pool',
        bookingId: input.bookingId,
        amount: n,
      });
      p.external.push({ method: input.method, amount: n });
      if (input.method === 'cash') fund(origin === 'rent' ? 'operating_cash' : 'deposit_pool', n);
    } else {
      const available = await sources(c, input.customerId);
      const seen = new Set<string>();
      let total = 0n,
        rentReleased = 0n;
      for (const s of input.sources) {
        const key = `${s.lotId}:${s.bucket}:${s.bookingId}:${s.fund}`;
        if (seen.has(key)) fail(422, 'DUPLICATE_SOURCE', 'Один источник указан дважды.');
        seen.add(key);
        const a = available.find(
          (a) =>
            a.lotId === s.lotId &&
            a.bucket === s.bucket &&
            a.bookingId === s.bookingId &&
            a.fund === s.fund,
        );
        const n = BigInt(s.amountRub);
        total = bounded(total + n);
        if (!a || BigInt(a.availableRub) < n)
          fail(422, 'INSUFFICIENT_SOURCE', 'Недостаточно доступных средств выбранного источника.');
        if (
          (input.kind === 'credit_use' && s.bucket !== 'credit') ||
          (input.kind === 'to_credit' && (s.bucket === 'credit' || s.bookingId !== input.bookingId))
        )
          fail(422, 'SOURCE_NOT_ALLOWED', 'Источник не подходит для этого действия.');
        if (input.kind === 'refund' && s.bucket !== 'credit' && s.bookingId !== input.bookingId)
          fail(422, 'SOURCE_NOT_ALLOWED', 'Для возврата выберите соответствующую бронь.');
        p.allocations.push({
          lotId: s.lotId,
          bucket: s.bucket,
          fund: s.fund,
          bookingId: s.bookingId,
          amount: -n,
        });
        if (input.kind === 'to_credit') {
          if (s.bucket === 'rent') rentReleased += n;
          p.allocations.push({
            lotId: s.lotId,
            bucket: 'credit',
            fund: s.fund,
            bookingId: null,
            amount: n,
          });
        } else if (input.kind === 'credit_use') {
          p.allocations.push({
            lotId: s.lotId,
            bucket: 'rent',
            fund: a.method === 'cash' ? 'operating_cash' : null,
            bookingId: input.bookingId,
            amount: n,
          });
          if (a.fund === 'deposit_pool') {
            fund('deposit_pool', -n);
            fund('operating_cash', n);
          }
        } else {
          if (a.method === 'bank' && input.method === 'cash')
            fail(422, 'REFUND_METHOD_MISMATCH', 'Безналичный источник нельзя вернуть наличными.');
          // Return from the physical location of this allocation, not just its original origin.
          if (input.method === 'cash') {
            if (a.fund === null)
              fail(
                422,
                'SOURCE_FUND_UNKNOWN',
                'У наличного источника не указан физический фонд. Возврат наличными недоступен.',
              );
            fund(a.fund, -n);
          }
        }
      }
      if (input.kind === 'to_credit' && rentReleased > BigInt(summary!.overpaymentRub))
        fail(
          422,
          'OVERPAYMENT_EXCEEDED',
          'В остаток клиента можно перевести только фактическую переплату аренды.',
        );
      if (
        input.kind === 'credit_use' &&
        (summary!.status !== 'confirmed' || total > BigInt(summary!.debtRub))
      )
        fail(
          422,
          'DEBT_EXCEEDED',
          'Зачёт не может превышать актуальный долг подтверждённой брони.',
        );
      if (input.kind === 'refund') p.external.push({ method: input.method, amount: -total });
    }
    // Validate compensation and resulting per-source balances before any writes.
    const deltas = new Map<string, { a: Allocation; n: bigint }>();
    for (const a of p.allocations) {
      const key = `${a.lotId}:${a.bucket}:${a.bookingId}:${a.fund}`;
      const entry = deltas.get(key) ?? { a, n: 0n };
      entry.n += a.amount;
      deltas.set(key, entry);
    }
    for (const { a, n } of deltas.values()) {
      const balance =
        a.lotId === 0
          ? 0n
          : BigInt(
              (
                await c.query<{ amount: string }>(
                  'SELECT coalesce(sum(amount_rub),0)::text AS amount FROM finance_allocations WHERE lot_id=$1 AND bucket=$2 AND booking_id IS NOT DISTINCT FROM $3 AND fund IS NOT DISTINCT FROM $4',
                  [a.lotId, a.bucket, a.bookingId, a.fund],
                )
              ).rows[0].amount,
            );
      if (balance + n < 0n)
        fail(
          422,
          'INSUFFICIENT_SOURCE',
          'Средства уже использованы. Сначала компенсируйте зависимые операции.',
        );
      bounded(balance + n);
    }
    return p;
  }
  async warning(c: PoolClient, input: FinanceInput, p: Plan) {
    const state = await funds(c);
    const projected = state.items.map((f) => ({
      ...f,
      afterRub: bounded(BigInt(f.balanceRub) + (p.funds[f.id] ?? 0n)).toString(),
    }));
    const negative = projected.filter((f) => (p.funds[f.id] ?? 0n) < 0n && BigInt(f.afterRub) < 0n);
    const body = { ...input };
    delete body.warningToken;
    delete body.shortfallAcknowledged;
    return {
      funds: projected,
      negative,
      token: hash(JSON.stringify({ body, projected })),
      depositShortfallRub: state.depositShortfallRub,
    };
  }
  async preview(input: FinanceInput) {
    return this.db.transaction(async (c) => {
      await this.lock(c, input);
      const p = await this.plan(c, input);
      return this.warning(c, input, p);
    });
  }
  async post(input: FinanceInput, r: AuthRequest) {
    return this.commands.run(
      r,
      'finance.post',
      input,
      async (c) => {
        const commandId = `${r.auth!.user.id}:${this.commands.key(r)}`,
          requestHash = hash(JSON.stringify(input));
        const existing = (
          await c.query<{ id: number; request_hash: string }>(
            'SELECT id,request_hash FROM financial_operations WHERE command_id=$1',
            [commandId],
          )
        ).rows[0];
        if (existing) {
          if (existing.request_hash !== requestHash)
            fail(409, 'IDEMPOTENCY_KEY_REUSED', 'Ключ уже использован для другой операции.');
          return { id: existing.id };
        }
        await this.lock(c, input);
        const p = await this.plan(c, input),
          warning = await this.warning(c, input, p);
        if (
          warning.negative.length &&
          (!input.shortfallAcknowledged || input.warningToken !== warning.token)
        )
          fail(
            409,
            'FUND_SHORTFALL_CONFIRMATION',
            'Физических денег недостаточно. Проверьте актуальные остатки, подтвердите предупреждение и укажите причину.',
            warning,
          );
        const op = (
          await c.query<{ id: number }>(
            `INSERT INTO financial_operations(command_id,request_hash,kind,customer_id,booking_id,actor_id,reason,reversal_of) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
            [
              commandId,
              requestHash,
              input.kind,
              p.customerId ?? null,
              p.bookingId ?? null,
              r.auth!.user.id,
              input.reason,
              p.reversalOf ?? null,
            ],
          )
        ).rows[0];
        let lotId = 0;
        if (p.newLot)
          lotId = (
            await c.query<{ id: number }>(
              'INSERT INTO finance_lots(customer_id,original_operation_id,origin,method) VALUES ($1,$2,$3,$4) RETURNING id',
              [p.customerId, op.id, p.newLot.origin, p.newLot.method],
            )
          ).rows[0].id;
        for (const a of p.allocations)
          await c.query(
            'INSERT INTO finance_allocations(operation_id,lot_id,bucket,booking_id,amount_rub,fund) VALUES ($1,$2,$3,$4,$5,$6)',
            [op.id, a.lotId || lotId, a.bucket, a.bookingId, a.amount.toString(), a.fund],
          );
        for (const [fund, n] of Object.entries(p.funds)) {
          if (n === 0n && input.kind !== 'initial') continue;
          await c.query(
            'INSERT INTO finance_fund_entries(operation_id,fund,amount_rub,is_initial) VALUES ($1,$2,$3,$4)',
            [op.id, fund, n.toString(), input.kind === 'initial'],
          );
          await c.query('UPDATE finance_funds SET version=version+1 WHERE id=$1', [fund]);
        }
        for (const e of p.external)
          await c.query(
            'INSERT INTO finance_external(operation_id,method,amount_rub) VALUES ($1,$2,$3)',
            [op.id, e.method, e.amount.toString()],
          );
        // SQL sums are numeric: explicitly bound aggregate balances, not only individual entries.
        if (p.customerId) {
          const totals = (
            await c.query<{ bucket: AllocationBucket; booking_id: number | null; amount: string }>(
              `SELECT a.bucket,a.booking_id,sum(a.amount_rub)::text AS amount FROM finance_allocations a JOIN finance_lots l ON l.id=a.lot_id WHERE l.customer_id=$1 GROUP BY a.bucket,a.booking_id`,
              [p.customerId],
            )
          ).rows;
          for (const total of totals) bounded(BigInt(total.amount));
        }
        await recordEvent(c, r, op.id, input.kind, p.bookingId, {
          reason: input.reason,
          shortfallAcknowledged: warning.negative.length > 0,
          negativeFunds: warning.negative,
        });
        return { id: op.id };
      },
      false,
    );
  }
}
