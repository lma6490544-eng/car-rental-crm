const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { withFinance, code, singleEffects } = require('./helpers/finance-regression.cjs');
const {
  historicalSource,
  reads,
  validFundKeys,
  balance,
  sourceFor,
  inverse,
  sqlError,
  withMigratedHistory,
  withHttpApi,
} = require('./helpers/finance-nullable-fund.cjs');

const unknownFundMessage =
  'У наличного источника не указан физический фонд. Возврат наличными недоступен.';
const unknownFund = (error) => {
  code('SOURCE_FUND_UNKNOWN', 422)(error);
  assert.deepEqual(error.getResponse(), {
    code: 'SOURCE_FUND_UNKNOWN',
    message: unknownFundMessage,
  });
  return true;
};
const assertNoWrites = (trace) => {
  assert.equal(
    trace.some((event) => /^(INSERT|UPDATE|DELETE)\b/.test(event.sql)),
    false,
  );
  assert.ok(trace.some((event) => event.sql === 'ROLLBACK' && event.ok));
};

test('Nullable fund controls: partial/full refunds, inverse and replay retain exact funds', async (t) => {
  for (const [origin, method, fund] of [
    ['rent', 'cash', 'operating_cash'],
    ['deposit', 'cash', 'deposit_pool'],
    ['rent', 'bank', null],
    // Physical location, not original deposit origin, determines the cash debit.
    ['deposit', 'cash', 'operating_cash'],
  ])
    await t.test(origin + '/' + method + '/' + fund, async () => {
      await withFinance(async (f) => {
        const h = await historicalSource(f, { origin, method, fund });
        const r = reads(f);
        const start = await f.fundState();
        const ids = [];
        for (const [amount, remaining] of [
          ['30', '70'],
          ['70', '0'],
        ]) {
          const body = f.refund(h, amount);
          const plan = await r.plan(body);
          assert.equal(validFundKeys(plan), true);
          assert.deepEqual(plan.funds, fund === null ? {} : { [fund]: -BigInt(amount) });
          const before = await f.snapshot();
          const request = f.request();
          const result = await f.post(body, request);
          ids.push(result.id);
          const after = await f.snapshot();
          singleEffects(before, after, result.id, { funds: fund === null ? 0 : 1 });
          assert.deepEqual(await f.post(body, request), result);
          assert.deepEqual(await f.snapshot(), after);
          await assert.rejects(
            f.post({ ...body, reason: 'Different body' }, request),
            code('IDEMPOTENCY_KEY_REUSED', 409),
          );
          assert.deepEqual(
            (await sourceFor(f, h)).map((row) => row.availableRub),
            remaining === '0' ? [] : [remaining],
          );
        }
        const end = await f.fundState();
        for (const id of ['operating_cash', 'deposit_pool'])
          assert.equal(balance(end, id), balance(start, id) - (id === fund ? 100n : 0n));
        for (const id of ids) {
          assert.equal(validFundKeys(await r.plan(inverse(id))), true);
          await f.post(inverse(id));
        }
        assert.equal((await sourceFor(f, h))[0].availableRub, '100');
        const restored = await f.fundState();
        for (const id of ['operating_cash', 'deposit_pool'])
          assert.equal(balance(restored, id), balance(start, id));
        await assert.rejects(f.post(inverse(ids[0])), code('ALREADY_REVERSED', 409));
      });
    });
});

test('Nullable cash regression: plan, preview and post reject unknown physical fund without writes', async (t) => {
  for (const origin of ['rent', 'deposit'])
    await t.test(origin + ' partial/full', async () => {
      await withFinance(async (f) => {
        const h = await historicalSource(f, {
          origin,
          fund: null,
          backingFund: origin === 'rent' ? 'operating_cash' : 'deposit_pool',
        });
        const r = reads(f);
        assert.equal((await sourceFor(f, h))[0].fund, null);
        for (const amount of ['30', '100']) {
          const body = f.refund(h, amount);
          const before = await f.snapshot();
          // Stage 20 characterized the defect; stage 21 retains these cases as regressions.
          await assert.rejects(r.plan(body), unknownFund);
          await f.observe(() => assert.rejects(r.controller.preview(body), unknownFund));
          assertNoWrites(f.trace);
          assert.deepEqual(await f.snapshot(), before, 'plan/preview are read-only');
          const request = f.request();
          await f.observe(() => assert.rejects(f.post(body, request), unknownFund));
          assertNoWrites(f.trace);
          assert.deepEqual(await f.snapshot(), before);
          await assert.rejects(f.post(body, request), unknownFund);
          await assert.rejects(f.lookup(request), code('OPERATION_NOT_FOUND', 404));
          assert.deepEqual(await f.snapshot(), before, 'no cached or permanent result on failure');
          t.diagnostic(
            JSON.stringify({
              regression: true,
              origin,
              amount,
              previewAndPost: '422 SOURCE_FUND_UNKNOWN',
              rollbackExact: true,
            }),
          );
        }
      });
    });
});

test('Nullable cash in mixed refunds rejects the entire command before writes in either source order', async (t) => {
  for (const nullFirst of [false, true])
    await t.test('null first=' + nullFirst, async () => {
      await withFinance(async (f) => {
        const valid = await historicalSource(f);
        const missing = await historicalSource(f, {
          customerId: valid.customerId,
          bookingId: valid.bookingId,
          fund: null,
          backingFund: 'deposit_pool',
        });
        const sources = [
          { ...valid.source, amountRub: '30' },
          { ...missing.source, amountRub: '40' },
        ];
        if (nullFirst) sources.reverse();
        const body = { ...f.refund(valid), sources };
        const before = await f.snapshot();
        await assert.rejects(reads(f).plan(body), unknownFund);
        await f.observe(() => assert.rejects(reads(f).controller.preview(body), unknownFund));
        assertNoWrites(f.trace);
        await f.observe(() => assert.rejects(f.post(body), unknownFund));
        assertNoWrites(f.trace);
        assert.deepEqual(
          await f.snapshot(),
          before,
          'all tables including versions/audit/outbox/cache restored',
        );
      });
    });
});

test('Nullable source release preserves null; subsequent cash refund fails while bank refund and its inverse remain supported', async () => {
  await withFinance(async (f) => {
    const h = await historicalSource(f, { fund: null, backingFund: 'deposit_pool' });
    const r = reads(f);
    const release = {
      kind: 'to_credit',
      customerId: h.customerId,
      bookingId: h.bookingId,
      expectedVersion: 1,
      reason: 'Diagnostic release',
      sources: [h.source],
    };
    assert.deepEqual((await r.plan(release)).funds, {});
    const before = await f.snapshot();
    const moved = await f.post(release);
    singleEffects(before, await f.snapshot(), moved.id, { allocations: 2, funds: 0, external: 0 });
    const credit = (await sourceFor(f, h))[0];
    assert.equal(credit.bucket, 'credit');
    assert.equal(credit.fund, null);
    const body = {
      kind: 'refund',
      customerId: h.customerId,
      method: 'cash',
      reason: 'Credit diagnostic',
      sources: [{ lotId: h.lotId, bucket: 'credit', bookingId: null, fund: null, amountRub: '30' }],
    };
    const released = await f.snapshot();
    await assert.rejects(r.plan(body), unknownFund);
    await assert.rejects(r.controller.preview(body), unknownFund);
    await assert.rejects(f.post(body), unknownFund);
    assert.deepEqual(await f.snapshot(), released);
    const bank = { ...body, method: 'bank' };
    assert.deepEqual((await r.plan(bank)).funds, {});
    const paid = await f.post(bank);
    singleEffects(released, await f.snapshot(), paid.id, { funds: 0 });
    assert.deepEqual((await r.plan(inverse(paid.id))).funds, {});
    const consumed = await f.snapshot();
    await assert.rejects(f.post(inverse(moved.id)), code('INSUFFICIENT_SOURCE'));
    assert.deepEqual(await f.snapshot(), consumed);
    await f.post(inverse(paid.id));
    await f.post(inverse(moved.id));
    assert.equal((await sourceFor(f, h))[0].bucket, 'deposit');
    assert.equal((await sourceFor(f, h))[0].availableRub, '100');
    assert.deepEqual((await f.snapshot()).finance_fund_entries, before.finance_fund_entries);
  });
});

test('Reversal of nullable allocation uses actual nonnull fund entries only, including history without any entries', async (t) => {
  for (const backingFund of ['deposit_pool', null])
    await t.test('backing=' + backingFund, async () => {
      await withFinance(async (f) => {
        const h = await historicalSource(f, { fund: null, backingFund });
        const plan = await reads(f).plan(inverse(h.receipt));
        assert.equal(validFundKeys(plan), true);
        assert.equal(plan.allocations[0].fund, null);
        assert.deepEqual(plan.funds, backingFund === null ? {} : { deposit_pool: -100n });
        const before = await f.snapshot();
        const result = await f.post(inverse(h.receipt));
        singleEffects(before, await f.snapshot(), result.id, {
          funds: backingFund === null ? 0 : 1,
        });
        assert.deepEqual(await sourceFor(f, h), []);
        assert.ok((await f.fundState()).items.every((row) => row.balanceRub === '0'));
      });
    });
});

test('Nullable diagnostics retain source identity, limits, gate and database constraints', async () => {
  await withFinance(async (f) => {
    const h = await historicalSource(f, { origin: 'rent', method: 'bank', fund: null });
    const before = await f.snapshot();
    await assert.rejects(
      f.post({ ...f.refund(h), method: 'cash' }),
      code('REFUND_METHOD_MISMATCH'),
    );
    await assert.rejects(f.post(f.refund(h, '101')), code('INSUFFICIENT_SOURCE'));
    await assert.rejects(
      f.post({ ...f.refund(h), sources: [h.source, h.source] }),
      code('DUPLICATE_SOURCE'),
    );
    await assert.rejects(
      f.post({ ...f.refund(h), sources: [{ ...h.source, fund: 'operating_cash' }] }),
      code('INSUFFICIENT_SOURCE'),
    );
    for (const kind of ['rent_payment', 'deposit_receipt', 'credit_use']) {
      const body = {
        kind,
        customerId: h.customerId,
        bookingId: h.bookingId,
        expectedVersion: 1,
        reason: 'Gate diagnostic',
        ...(kind === 'credit_use'
          ? { sources: [{ ...h.source, bucket: 'credit', bookingId: null }] }
          : { method: 'cash', amountRub: '1' }),
      };
      await assert.rejects(reads(f).controller.preview(body), code('RENTAL_NOT_ISSUED'));
      await assert.rejects(f.post(body), code('RENTAL_NOT_ISSUED'));
    }
    await assert.rejects(
      f.db.pool.query(
        'INSERT INTO finance_fund_entries(operation_id,fund,amount_rub) VALUES ($1,NULL,1)',
        [h.receipt],
      ),
      sqlError('23502'),
    );
    await assert.rejects(
      f.db.pool.query(
        "INSERT INTO finance_fund_entries(operation_id,fund,amount_rub) VALUES ($1,'null',1)",
        [h.receipt],
      ),
      sqlError('23503'),
    );
    await assert.rejects(
      f.db.pool.query('UPDATE finance_allocations SET fund=$1 WHERE lot_id=$2', [
        'operating_cash',
        h.lotId,
      ]),
      sqlError('23514'),
    );
    assert.deepEqual(await f.snapshot(), before);
  });
});

test('Migration 0011 retains historical null cash allocations and the planner rejects cash refund', async () => {
  await withMigratedHistory(async (f) => {
    const { sources } = require('../dist/finance/ledger');
    const rows = await f.db.transaction((c) => sources(c, f.customerId));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].fund, null);
    assert.equal(rows[0].method, 'cash');
    assert.equal(rows[0].availableRub, '100');
    const body = {
      kind: 'refund',
      customerId: f.customerId,
      method: 'cash',
      reason: 'Migrated history diagnostic',
      sources: [
        { lotId: f.lotId, bucket: 'credit', bookingId: null, fund: null, amountRub: '100' },
      ],
    };
    await assert.rejects(reads(f).plan(body), unknownFund);
    const column = (
      await f.db.pool.query(
        "SELECT is_nullable,column_default FROM information_schema.columns WHERE table_name='finance_allocations' AND column_name='fund'",
      )
    ).rows[0];
    assert.deepEqual(column, { is_nullable: 'YES', column_default: null });
  });
});

test('Real authenticated HTTP rejects nullable cash preview and repeated POST with 422 and unchanged state', async () => {
  await withFinance(async (f) => {
    const h = await historicalSource(f, { fund: null, backingFund: 'deposit_pool' });
    await withHttpApi(f, async (call) => {
      const before = await f.snapshot();
      const view = await call('customers/' + h.customerId + '/finance');
      assert.equal(view.status, 200);
      assert.equal(view.body.sources[0].fund, null);
      const body = f.refund(h, '30');
      const preview = await call('financial-operations/preview', body);
      assert.equal(preview.status, 422);
      assert.equal(preview.body.code, 'SOURCE_FUND_UNKNOWN');
      assert.equal(preview.body.message, unknownFundMessage);
      assert.equal('token' in preview.body, false);
      assert.equal('warningToken' in preview.body, false);
      assert.equal('details' in preview.body, false);
      assert.deepEqual(await f.snapshot(), before);
      const key = randomUUID();
      for (let attempt = 0; attempt < 2; attempt++) {
        const posted = await call('financial-operations', body, key);
        assert.equal(posted.status, 422);
        assert.equal(posted.body.code, 'SOURCE_FUND_UNKNOWN');
        assert.equal(posted.body.message, unknownFundMessage);
        assert.equal(typeof posted.body.requestId, 'string');
        assert.equal(JSON.stringify(posted.body).includes('finance_fund_entries'), false);
        assert.deepEqual(await f.snapshot(), before);
      }
      const lookup = await call('operations/by-key?command=finance.post&key=' + key);
      assert.equal(lookup.status, 404);
      assert.equal(lookup.body.code, 'OPERATION_NOT_FOUND');
      assert.deepEqual(await f.snapshot(), before);
    });
  });
});
