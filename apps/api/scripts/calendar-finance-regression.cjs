const assert = require('node:assert/strict');
const { operation, allocation, addTerms } = require('./calendar-finance-fixture.cjs');
const normalize = (value) =>
  JSON.parse(JSON.stringify(value, (key, v) => (key === 'evaluatedAt' ? undefined : v)));
module.exports = async function financeRegression({ db, request, rpc, waitForPause }) {
  const tables = [
    'booking_terms',
    'financial_operations',
    'finance_charges',
    'finance_allocations',
    'finance_lots',
    'finance_external',
    'finance_fund_entries',
    'finance_funds',
    'audit_logs',
    'outbox_jobs',
  ];
  async function fingerprint() {
    const result = {};
    for (const table of tables)
      result[table] = (
        await db.query(
          `SELECT md5(coalesce(string_agg(t::text,E'\n' ORDER BY t::text),'')) AS hash FROM ${table} t`,
        )
      ).rows[0].hash;
    return result;
  }
  const beforeReads = await fingerprint();
  async function compare() {
    const current = await request('current', false, false, true);
    const reference = await request('before-summary', false, false, true);
    assert.deepEqual(
      normalize(current.data),
      normalize(reference.data),
      'complete calendar with historical finances matches pre-5.3',
    );
    assert.deepEqual(
      normalize(current.evaluations),
      normalize(reference.evaluations),
      'both signed evaluation contexts match',
    );
    const ids = (await db.query('SELECT id FROM bookings ORDER BY id DESC')).rows.map((b) => b.id);
    const result = await rpc('summaries', ids);
    assert.ok(!result.error, result.error);
    assert.deepEqual(
      result.individual,
      result.original,
      'ordinary formulas match frozen ledger including cancelled/outside bookings',
    );
    if (result.batch) {
      assert.deepEqual(result.batch, result.original, 'every batch entry matches frozen ledger');
      assert.equal(result.emptySize, 0);
      assert.equal(result.emptyQueries, 0);
    }
    return { view: current.data, summaries: new Map(result.original.map((b) => [b.bookingId, b])) };
  }
  const initial = await compare();
  const bookings = (
    await db.query("SELECT * FROM bookings WHERE start_at>='2055-01-01' ORDER BY id")
  ).rows;
  const summary = (i) => initial.summaries.get(bookings[i].id);
  assert.equal(summary(0).priceRub, '0');
  assert.equal(summary(0).coverageRub, '0');
  assert.equal(summary(0).paidPercent, '100');
  for (const i of [1, 2, 3, 4]) assert.equal(summary(i).priceRub, '0');
  assert.equal(summary(5).priceRub, '9007199254740993123');
  assert.equal(summary(5).coverageRub, '9007199254740992668');
  assert.equal(summary(5).paidPercent, '99');
  assert.equal(summary(5).overpaymentRub, '9007199254740985668');
  assert.equal(summary(5).suggestedDepositRub, '15000');
  assert.equal(summary(6).suggestedDepositRub, '10000');
  assert.equal(summary(6).coverageRub, '11667');
  assert.equal(summary(6).depositRub, '10000');
  assert.equal(summary(7).coverageRub, '0');
  assert.equal(summary(7).depositRub, '0');
  assert.equal(
    summary(8).coverageRub,
    '4000',
    'refund compensation restores exactly the original coverage',
  );
  const customers = [...new Set(bookings.map((b) => b.customer_id))];
  for (const value of initial.summaries.values()) {
    assert.equal(
      value.availableCreditRub,
      String(900 + customers.indexOf(value.customerId)),
      'credit includes outside-window source of the same client',
    );
    assert.equal(value.debtRub, '0');
    assert.equal(value.paymentsAllowed, false);
  }
  assert.deepEqual(
    await fingerprint(),
    beforeReads,
    'all calendar and summary reads leave finance, terms, audit and outbox unchanged',
  );
  // Additional correctness-only history; timed finance-v1 fixtures remain unchanged.
  const root = bookings[0];
  const receipt = await operation(db, root, 'deposit_receipt');
  const extraLot = (
    await db.query(
      "INSERT INTO finance_lots(customer_id,original_operation_id,origin,method) VALUES ($1,$2,'deposit','cash') RETURNING id",
      [root.customer_id, receipt],
    )
  ).rows[0].id;
  await allocation(db, receipt, extraLot, 'deposit', root.id, '2000', null);
  await db.query(
    "INSERT INTO finance_external(operation_id,method,amount_rub) VALUES ($1,'cash',2000)",
    [receipt],
  );
  await db.query(
    "INSERT INTO finance_fund_entries(operation_id,fund,amount_rub) VALUES ($1,'deposit_pool',2000)",
    [receipt],
  );
  const released = await operation(db, root, 'to_credit');
  await allocation(db, released, extraLot, 'deposit', root.id, '-2000', null);
  await allocation(db, released, extraLot, 'credit', null, '2000', null);
  const refunded = await operation(db, root, 'refund');
  await allocation(db, refunded, extraLot, 'credit', null, '-10', null);
  await db.query(
    "INSERT INTO finance_external(operation_id,method,amount_rub) VALUES ($1,'cash',-10)",
    [refunded],
  );
  await db.query(
    "INSERT INTO finance_fund_entries(operation_id,fund,amount_rub) VALUES ($1,'deposit_pool',-10)",
    [refunded],
  );
  const multipleSourcesState = await fingerprint();
  const multipleSources = await compare();
  assert.equal(
    multipleSources.summaries.get(root.id).depositRub,
    '0',
    'a present bucket can sum to zero',
  );
  assert.equal(
    multipleSources.summaries.get(root.id).availableCreditRub,
    '2890',
    'credit includes both cash/deposit and bank/rent lots, including NULL fund history',
  );
  assert.equal(
    multipleSources.summaries.get(bookings[1].id).availableCreditRub,
    '901',
    'other customer funds stay separate',
  );
  assert.deepEqual(
    await fingerprint(),
    multipleSourcesState,
    'reading additional sources does not write',
  );
  const cancelled = bookings[9];
  await db.query("UPDATE bookings SET status='cancelled' WHERE id=$1", [cancelled.id]);
  const cancelledResult = await compare();
  assert.equal(cancelledResult.summaries.get(cancelled.id).priceRub, '0');
  const oldView = (await request()).data;
  const paused = waitForPause();
  const pending = request('current', true);
  pending.catch(() => {});
  await paused;
  const writer = await db.connect();
  try {
    await writer.query('BEGIN');
    const root = bookings[0];
    const terms = await addTerms(writer, root, 9, { finalTotalRub: '12345' });
    const charge = await operation(writer, root, 'charge');
    await writer.query(
      'INSERT INTO finance_charges(operation_id,booking_id,terms_id,amount_rub) VALUES ($1,$2,$3,200)',
      [charge, root.id, terms],
    );
    const source = (
      await writer.query(
        "SELECT l.id FROM finance_lots l JOIN finance_allocations a ON a.lot_id=l.id WHERE l.customer_id=$1 AND a.bucket='credit' ORDER BY l.id LIMIT 1",
        [root.customer_id],
      )
    ).rows[0].id;
    const transfer = await operation(writer, root, 'credit_use');
    await allocation(writer, transfer, source, 'credit', null, '-23');
    await allocation(writer, transfer, source, 'rent', root.id, '23');
    await writer.query('COMMIT');
  } catch (error) {
    await writer.query('ROLLBACK');
    throw error;
  } finally {
    writer.release();
    await rpc('resume');
  }
  assert.deepEqual(
    normalize((await pending).data),
    normalize(oldView),
    'financial commit cannot mix the active RR snapshot',
  );
  const afterWrites = await fingerprint();
  const fresh = await compare();
  const first = fresh.summaries.get(bookings[0].id);
  assert.equal(first.priceRub, '12345');
  assert.equal(first.coverageRub, '23');
  assert.equal(first.availableCreditRub, '2867');
  assert.deepEqual(
    await fingerprint(),
    afterWrites,
    'next GET observes committed finance without writing',
  );
};
