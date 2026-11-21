const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  withFinance,
  code,
  onlyAppends,
  singleEffects,
} = require('./helpers/finance-regression.cjs');
const MAX = 9223372036854775807n;

const reversal = (id) => ({ kind: 'reversal', operationId: id, reason: 'Regression inverse' });
const initial = (amountRub) => ({
  kind: 'initial',
  fund: 'operating_cash',
  amountRub,
  reason: 'Regression initial',
});

test('Finance regression A: rent release uses legacy charges, latest terms and exact source provenance', async () => {
  await withFinance(async (f) => {
    const h = await f.historical({ origin: 'rent', price: '60' });
    const charge = await f.operation('charge', h.customerId, h.bookingId);
    await f.db.pool.query(
      'INSERT INTO finance_charges(operation_id,booking_id,terms_id,amount_rub) VALUES ($1,$2,$3,$4)',
      [charge, h.bookingId, h.termsId, '60'],
    );
    await f.terms(h.bookingId, 2, '40');
    const expected = {
      bookingId: h.bookingId,
      customerId: h.customerId,
      bookingVersion: 1,
      status: 'confirmed',
      paymentsAllowed: false,
      priceRub: '40',
      coverageRub: '100',
      debtRub: '0',
      overpaymentRub: '40',
      depositRub: '0',
      availableCreditRub: '0',
      suggestedDepositRub: '10000',
      paidPercent: '100',
    };
    assert.deepEqual(await f.summary(h.bookingId), expected);
    const body = {
      kind: 'to_credit',
      customerId: h.customerId,
      bookingId: h.bookingId,
      expectedVersion: 1,
      reason: 'Release actual legacy overpayment',
      sources: [{ ...h.source, amountRub: '30' }],
    };
    const before = await f.snapshot();
    assert.equal((await f.post(body, f.request())).id > 0, true);
    const after = await f.snapshot();
    onlyAppends(before, after, [
      'financial_operations',
      'finance_allocations',
      'audit_logs',
      'outbox_jobs',
      'idempotency_records',
    ]);
    const added = after.finance_allocations.filter(
      (row) => !before.finance_allocations.some((old) => old.id === row.id),
    );
    assert.deepEqual(
      added
        .map((row) => ({
          lotId: row.lot_id,
          bucket: row.bucket,
          bookingId: row.booking_id,
          fund: row.fund,
          amountRub: String(row.amount_rub),
        }))
        .sort((a, b) => a.bucket.localeCompare(b.bucket)),
      [
        { lotId: h.lotId, bucket: 'credit', bookingId: null, fund: h.fund, amountRub: '30' },
        { lotId: h.lotId, bucket: 'rent', bookingId: h.bookingId, fund: h.fund, amountRub: '-30' },
      ],
    );
    assert.equal(
      (
        await f.db.pool.query(
          'SELECT sum(amount_rub)::text n FROM finance_allocations WHERE lot_id=$1',
          [h.lotId],
        )
      ).rows[0].n,
      '100',
    );
    assert.deepEqual(await f.summary(h.bookingId), {
      ...expected,
      coverageRub: '70',
      overpaymentRub: '10',
      availableCreditRub: '30',
    });
    await assert.rejects(
      f.post({ ...body, sources: [{ ...h.source, amountRub: '11' }] }),
      code('OVERPAYMENT_EXCEEDED'),
    );
    assert.deepEqual(await f.snapshot(), after);
    const r = f.request();
    const last = { ...body, sources: [{ ...h.source, amountRub: '10' }] };
    const result = await f.post(last, r);
    assert.deepEqual(await f.summary(h.bookingId), {
      ...expected,
      coverageRub: '60',
      overpaymentRub: '0',
      availableCreditRub: '40',
    });
    const committed = await f.snapshot();
    assert.deepEqual(await f.post(last, r), result);
    assert.deepEqual(await f.snapshot(), committed);
    for (const table of [
      'finance_funds',
      'finance_fund_entries',
      'finance_external',
      'finance_lots',
      'finance_charges',
      'booking_terms',
    ])
      assert.deepEqual(committed[table], before[table], table);
  });
});

test(
  'Finance regression B: initial races, zero/MAX, replay and historical-work ordering',
  { timeout: 90000 },
  async (t) => {
    await t.test('two distinct keys initialize one fund only once', async () => {
      await withFinance(async (f) => {
        const bodies = [initial('0'), initial(MAX.toString())];
        const requests = [f.request(), f.request()];
        const before = await f.snapshot();
        const results = await f.orderedRace(
          () => f.post(bodies[0], requests[0]),
          () => f.post(bodies[1], requests[1]),
        );
        assert.equal(results[0].status, 'fulfilled');
        assert.equal(results[1].status, 'rejected');
        code('INITIAL_LOCKED')(results[1].reason);
        const after = await f.snapshot();
        singleEffects(before, after, results[0].value.id, {
          allocations: 0,
          funds: 1,
          external: 0,
        });
        assert.deepEqual(
          after.finance_funds.map((row) => [row.id, row.version]),
          [
            ['deposit_pool', 1],
            ['operating_cash', 2],
          ],
        );
        assert.deepEqual(
          after.finance_fund_entries.map((row) => [
            row.fund,
            String(row.amount_rub),
            row.is_initial,
          ]),
          [['operating_cash', '0', true]],
        );
        assert.deepEqual(await f.post(bodies[0], requests[0]), results[0].value);
        await assert.rejects(f.post(bodies[1], requests[1]), code('INITIAL_LOCKED'));
        assert.deepEqual(await f.snapshot(), after);
      });
    });
    await t.test(
      'MAX initial succeeds exactly and replays without fund version growth',
      async () => {
        await withFinance(async (f) => {
          const r = f.request();
          const body = initial(MAX.toString());
          const result = await f.post(body, r);
          const after = await f.snapshot();
          assert.equal(after.finance_fund_entries.length, 1);
          assert.equal(String(after.finance_fund_entries[0].amount_rub), MAX.toString());
          assert.equal(after.finance_fund_entries[0].is_initial, true);
          assert.equal(
            (await f.fundState()).items.find((row) => row.id === 'operating_cash').balanceRub,
            MAX.toString(),
          );
          assert.deepEqual(await f.post(body, r), result);
          assert.deepEqual(await f.snapshot(), after);
        });
      },
    );
    for (const initialFirst of [true, false]) {
      await t.test(
        'historical receipt already forbids initial; first new refund, initial queued first=' +
          initialFirst,
        async () => {
          await withFinance(async (f) => {
            const h = await f.historical();
            assert.equal((await f.fundState()).initialAllowed, false);
            const before = await f.snapshot();
            const calls = [() => f.post(initial('0')), () => f.post(f.refund(h, '10'))];
            const results = await f.orderedRace(...(initialFirst ? calls : calls.toReversed()));
            const failure = results[initialFirst ? 0 : 1];
            const success = results[initialFirst ? 1 : 0];
            assert.equal(failure.status, 'rejected');
            code('INITIAL_LOCKED')(failure.reason);
            assert.equal(success.status, 'fulfilled');
            const after = await f.snapshot();
            singleEffects(before, after, success.value.id);
            assert.equal(after.finance_fund_entries.filter((row) => row.is_initial).length, 0);
            assert.deepEqual(
              after.finance_funds.map((row) => [row.id, row.version]),
              [
                ['deposit_pool', 2],
                ['operating_cash', 1],
              ],
            );
            assert.equal((await f.sourceState(h.customerId))[0].availableRub, '90');
          });
        },
      );
    }
  },
);

test('Finance regression C: real post-insert aggregate overflow rolls back and same key later succeeds', async () => {
  await withFinance(async (f) => {
    const first = await f.historical({
      origin: 'rent',
      method: 'bank',
      credit: true,
      amount: '10',
    });
    const refund = await f.post(f.refund(first));
    const second = await f.historical({
      origin: 'rent',
      method: 'bank',
      credit: true,
      customerId: first.customerId,
      amount: (MAX - 5n).toString(),
    });
    await f.probes();
    const r = f.request();
    const body = reversal(refund.id);
    const before = await f.snapshot();
    await f.observe(() => assert.rejects(f.post(body, r), code('MONEY_OVERFLOW')));
    const seen = await f.counts();
    assert.equal(seen.financial_operations, 1);
    assert.equal(seen.finance_allocations, 1);
    assert.equal(seen.finance_external, 1);
    for (const table of [
      'finance_lots',
      'finance_fund_entries',
      'fund_versions',
      'audit_logs',
      'outbox_jobs',
      'idempotency_records',
    ])
      assert.equal(seen[table], 0, table);
    assert.ok(
      f.trace.some((event) => event.ok && event.sql.includes('GROUP BY a.bucket,a.booking_id')),
    );
    assert.equal(f.trace.filter((event) => event.sql === 'ROLLBACK' && event.ok).length, 1);
    assert.deepEqual(await f.snapshot(), before);
    await assert.rejects(f.lookup(r), code('OPERATION_NOT_FOUND', 404));
    assert.deepEqual(await f.snapshot(), before);
    // Correct the aggregate with another allowed refund; never rewrite immutable history.
    await f.post(f.refund(second, '5'));
    const corrected = await f.snapshot();
    const result = await f.post(body, r);
    const after = await f.snapshot();
    singleEffects(corrected, after, result.id, { funds: 0 });
    assert.equal(
      after.finance_allocations.find((row) => row.operation_id === result.id).amount_rub,
      '10',
    );
    assert.equal(
      after.finance_external.find((row) => row.operation_id === result.id).amount_rub,
      '10',
    );
    const state = await f.sourceState(first.customerId);
    assert.equal(state.find((row) => row.lotId === first.lotId).availableRub, '10');
    assert.equal(
      state.find((row) => row.lotId === second.lotId).availableRub,
      (MAX - 10n).toString(),
    );
    assert.equal(
      state.reduce((sum, row) => sum + BigInt(row.availableRub), 0n).toString(),
      MAX.toString(),
    );
    assert.deepEqual(await f.post(body, r), result);
    assert.deepEqual(await f.snapshot(), after);
  });
});

test(
  'Finance regression D: dependent receipt inverse versus refund in both observed lock orders',
  { timeout: 60000 },
  async (t) => {
    for (const inverseFirst of [true, false]) {
      await t.test('schedule lock granted to reversal first=' + inverseFirst, async () => {
        await withFinance(async (f) => {
          const h = await f.historical();
          const before = await f.snapshot();
          const inverse = reversal(h.receipt);
          const refund = f.refund(h, '60');
          const r = f.request();
          const otherRequest = f.request();
          const calls = [() => f.post(inverse, r), () => f.post(refund, otherRequest)];
          const results = await f.orderedRace(...(inverseFirst ? calls : calls.toReversed()));
          assert.equal(results[0].status, 'fulfilled');
          assert.equal(results[1].status, 'rejected');
          code('INSUFFICIENT_SOURCE')(results[1].reason);
          const after = await f.snapshot();
          singleEffects(before, after, results[0].value.id);
          const amount = inverseFirst ? '-100' : '-60';
          const newAllocation = after.finance_allocations.find(
            (row) => row.operation_id === results[0].value.id,
          );
          assert.deepEqual(
            [
              newAllocation.lot_id,
              newAllocation.bucket,
              newAllocation.booking_id,
              newAllocation.fund,
              String(newAllocation.amount_rub),
            ],
            [h.lotId, 'deposit', h.bookingId, 'deposit_pool', amount],
          );
          assert.equal(
            String(
              after.finance_external.find((row) => row.operation_id === results[0].value.id)
                .amount_rub,
            ),
            amount,
          );
          assert.equal(
            String(
              after.finance_fund_entries.find((row) => row.operation_id === results[0].value.id)
                .amount_rub,
            ),
            amount,
          );
          const remaining = await f.sourceState(h.customerId);
          assert.deepEqual(
            remaining.map((row) => row.availableRub),
            inverseFirst ? [] : ['40'],
          );
          assert.equal(
            after.financial_operations.filter((row) => row.reversal_of === h.receipt).length,
            inverseFirst ? 1 : 0,
          );
          await assert.rejects(
            f.post(inverse),
            code(
              inverseFirst ? 'ALREADY_REVERSED' : 'INSUFFICIENT_SOURCE',
              inverseFirst ? 409 : 422,
            ),
          );
          assert.deepEqual(await f.snapshot(), after);
        });
      });
    }
  },
);

test('Finance regression E: late idempotency result fault rolls back money, versions and events', async () => {
  await withFinance(async (f) => {
    const h = await f.historical();
    await f.probes();
    await f.fault('P0001', 1);
    const before = await f.snapshot();
    const r = f.request();
    const body = f.refund(h, '30');
    await assert.rejects(f.post(body, r), (error) => error.code === 'P0001');
    const seen = await f.counts();
    for (const table of [
      'financial_operations',
      'finance_allocations',
      'finance_fund_entries',
      'finance_external',
      'fund_versions',
      'audit_logs',
      'outbox_jobs',
    ])
      assert.equal(seen[table], 1, table + ' executed before fault');
    assert.equal(seen.finance_lots, 0, 'allowed refund never creates a new lot');
    assert.equal(seen.idempotency_records, 0);
    assert.deepEqual(await f.snapshot(), before);
    await assert.rejects(f.lookup(r), code('OPERATION_NOT_FOUND', 404));
    assert.deepEqual(await f.snapshot(), before);
    await f.db.pool.query('DROP TRIGGER stage17_fail ON idempotency_records');
    const result = await f.post(body, r);
    const after = await f.snapshot();
    singleEffects(before, after, result.id);
    for (const table of ['finance_allocations', 'finance_fund_entries', 'finance_external'])
      assert.equal(
        after[table].find((row) => row.operation_id === result.id).amount_rub,
        '-30',
        table,
      );
    assert.equal((await f.sourceState(h.customerId))[0].availableRub, '70');
    assert.deepEqual(await f.post(body, r), result);
    assert.deepEqual(await f.lookup(r), { status: 'completed', result });
    assert.deepEqual(await f.snapshot(), after);
    await f.db.pool.query(
      'DELETE FROM idempotency_records WHERE actor_id=$1 AND command=$2 AND key=$3',
      [f.actor, 'finance.post', r.headers['idempotency-key']],
    );
    const withoutCache = await f.snapshot();
    assert.deepEqual(await f.lookup(r), { status: 'completed', result });
    assert.deepEqual(await f.snapshot(), withoutCache);
    assert.deepEqual(await f.post(body, r), result);
    const recovered = await f.snapshot();
    for (const table of Object.keys(after))
      if (table !== 'idempotency_records') assert.deepEqual(recovered[table], after[table], table);
    assert.equal(recovered.idempotency_records.length, after.idempotency_records.length);
    assert.deepEqual(await f.lookup(r), { status: 'completed', result });
  });
});

test(
  'Finance regression F: actual PostgreSQL retry SQLSTATEs, complete rollback and fixed attempt limit',
  { timeout: 90000 },
  async (t) => {
    for (const sqlstate of ['40001', '40P01', '23514']) {
      for (const failures of sqlstate === '23514' ? [1] : [2, 3]) {
        await t.test(sqlstate + ', injected failures=' + failures, async () => {
          await withFinance(async (f) => {
            const h = await f.historical();
            await f.probes();
            await f.fault(sqlstate, failures);
            const before = await f.snapshot();
            const r = f.request();
            const body = f.refund(h, '25');
            const succeeds = failures === 2;
            const attempts = sqlstate === '23514' ? 1 : 3;
            let result;
            await f.observe(async () => {
              if (succeeds) result = await f.post(body, r);
              else await assert.rejects(f.post(body, r), (error) => error.code === sqlstate);
            });
            const trace = [...f.trace];
            const seen = await f.counts();
            for (const table of [
              'financial_operations',
              'finance_allocations',
              'finance_external',
              'finance_fund_entries',
              'fund_versions',
              'audit_logs',
              'outbox_jobs',
            ])
              assert.equal(seen[table], attempts, table);
            assert.equal(seen.idempotency_records, succeeds ? 1 : 0);
            assert.equal(seen.finance_lots, 0);
            assert.equal(
              (await f.db.pool.query('SELECT last_value::int n FROM stage17.attempts')).rows[0].n,
              attempts,
            );
            const successful = trace.filter((event) => event.ok);
            assert.equal(successful.filter((event) => event.sql === 'BEGIN').length, attempts);
            assert.equal(
              successful.filter((event) => event.sql === 'ROLLBACK').length,
              succeeds ? 2 : attempts,
            );
            assert.equal(
              successful.filter((event) => event.sql === 'COMMIT').length,
              succeeds ? 1 : 0,
            );
            const authorizations = successful.filter((event) =>
              event.sql.includes('FOR SHARE OF u,s'),
            );
            assert.equal(authorizations.length, attempts);
            assert.ok(authorizations.every((event) => event.rowCount === 1));
            const lockPatterns = [
              'hashtextextended($1,0)',
              "hashtextextended('crm:schedule',0)",
              'SELECT id FROM bookings WHERE id=$1 FOR UPDATE',
              'SELECT id FROM customers WHERE id=$1 FOR UPDATE',
              'SELECT id FROM finance_lots WHERE customer_id=$1 ORDER BY id FOR UPDATE',
              'SELECT id FROM finance_funds ORDER BY id FOR UPDATE',
            ];
            for (const sql of lockPatterns)
              assert.equal(
                successful.filter((event) => event.sql.includes(sql)).length,
                attempts,
                sql,
              );
            const chunks = [];
            for (const event of trace) {
              if (event.sql === 'BEGIN') chunks.push([]);
              chunks.at(-1).push(event);
            }
            for (const chunk of chunks) {
              const positions = lockPatterns.map((pattern) =>
                chunk.findIndex((event) => event.sql.includes(pattern)),
              );
              assert.ok(
                positions.every(
                  (position, index) =>
                    position >= 0 && (index === 0 || position > positions[index - 1]),
                ),
              );
              assert.ok(
                chunk.findIndex((event) => event.sql.includes('FOR SHARE OF u,s')) < positions[1],
              );
            }
            const after = await f.snapshot();
            if (succeeds) {
              singleEffects(before, after, result.id);
              for (const table of [
                'finance_allocations',
                'finance_fund_entries',
                'finance_external',
              ])
                assert.equal(
                  after[table].find((row) => row.operation_id === result.id).amount_rub,
                  '-25',
                  table,
                );
              assert.equal((await f.sourceState(h.customerId))[0].availableRub, '75');
              assert.deepEqual(
                after.finance_funds.map((row) => [row.id, row.version]),
                [
                  ['deposit_pool', 2],
                  ['operating_cash', 1],
                ],
              );
              assert.deepEqual(await f.post(body, r), result);
              assert.deepEqual(await f.snapshot(), after);
            } else {
              assert.deepEqual(after, before);
              await assert.rejects(f.lookup(r), code('OPERATION_NOT_FOUND', 404));
              assert.deepEqual(await f.snapshot(), before);
              await f.db.pool.query('DROP TRIGGER stage17_fail ON idempotency_records');
              result = await f.post(body, r);
              singleEffects(before, await f.snapshot(), result.id);
            }
          });
        });
      }
    }
  },
);
