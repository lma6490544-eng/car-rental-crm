const assert = require('node:assert/strict');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { Pool } = require('pg');
const { drizzle } = require('drizzle-orm/node-postgres');
const { migrate } = require('drizzle-orm/node-postgres/migrator');
const { trackPoolDisconnects } = require('./close-test-pool.cjs');
require('dotenv').config({ path: path.resolve(__dirname, '../../../../.env'), quiet: true });
const adminUrl = process.env.DATABASE_URL;
const moneyTables = [
  'financial_operations',
  'finance_charges',
  'finance_lots',
  'finance_allocations',
  'finance_external',
  'finance_fund_entries',
];
const probeTables = [...moneyTables, 'audit_logs', 'outbox_jobs', 'idempotency_records'];

const code =
  (expected, status = 422) =>
  (error) => {
    assert.equal(error.getStatus(), status);
    assert.equal(error.getResponse().code, expected);
    return true;
  };

async function withFinance(work) {
  const name = 'crm_finance_regression_test_' + randomBytes(8).toString('hex');
  const admin = new Pool({ connectionString: adminUrl });
  let close;
  try {
    await admin.query('CREATE DATABASE "' + name + '"');
    const url = new URL(adminUrl);
    url.pathname = '/' + name;
    process.env.DATABASE_URL = url.toString();
    const { DatabaseService } = require('../../dist/database.service');
    const { CommandsService } = require('../../dist/platform/commands.service');
    const { FinanceService } = require('../../dist/finance/finance.service');
    const { FinanceController } = require('../../dist/finance/finance.controller');
    const { OperationsController } = require('../../dist/identity/operations.controller');
    const ledger = require('../../dist/finance/ledger');
    const db = new DatabaseService();
    close = trackPoolDisconnects(db.pool);
    await migrate(drizzle(db.pool), { migrationsFolder: path.resolve(__dirname, '../../drizzle') });
    const commands = new CommandsService(db);
    const finance = new FinanceService(db, commands);
    const controller = new FinanceController(finance);
    const operations = new OperationsController(db, commands);
    const actor = (
      await db.pool.query(
        "INSERT INTO users(full_name,login,password_hash,role) VALUES ('Regression','regression','unused','manager') RETURNING id",
      )
    ).rows[0].id;
    await db.pool.query(
      "INSERT INTO sessions(user_id,token_hash,expires_at) VALUES ($1,'regression-session',now()+interval '1 hour')",
      [actor],
    );
    const group = (await db.pool.query("SELECT id FROM pricing_groups WHERE tariff_code='economy'"))
      .rows[0].id;
    const brand = (
      await db.pool.query("INSERT INTO vehicle_brands(name) VALUES ('Regression') RETURNING id")
    ).rows[0].id;
    const model = (
      await db.pool.query(
        "INSERT INTO vehicle_models(brand_id,name,pricing_group_id) VALUES ($1,'Regression',$2) RETURNING id",
        [brand, group],
      )
    ).rows[0].id;
    const request = () => ({
      headers: { 'idempotency-key': randomUUID() },
      requestId: randomUUID(),
      auth: { user: { id: actor }, tokenHash: 'regression-session' },
    });
    const post = (input, r = request()) => controller.post(input, r);
    const lookup = (r) =>
      operations.lookup({ command: 'finance.post', key: r.headers['idempotency-key'] }, r);
    const tables = (
      await db.pool.query(
        "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
      )
    ).rows.map((row) => row.tablename);
    const exactColumns = (
      await db.pool.query(
        "SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND udt_name IN ('int8','numeric') ORDER BY table_name,ordinal_position",
      )
    ).rows;
    async function snapshot() {
      const result = {};
      for (const table of tables) {
        assert.match(table, /^[a-z_][a-z0-9_]*$/);
        const columns = exactColumns
          .filter((column) => column.table_name === table)
          .map((column) => {
            assert.match(column.column_name, /^[a-z_][a-z0-9_]*$/);
            return "'" + column.column_name + '\',t."' + column.column_name + '"::text';
          });
        const exact = columns.length ? ' || jsonb_build_object(' + columns.join(',') + ')' : '';
        result[table] = (
          await db.pool.query(
            'SELECT coalesce(jsonb_agg(to_jsonb(t)' +
              exact +
              " ORDER BY t::text),'[]'::jsonb) rows FROM \"" +
              table +
              '" t',
          )
        ).rows[0].rows;
      }
      return result;
    }
    async function operation(kind, customerId, bookingId, reason = 'Historical fixture') {
      return (
        await db.pool.query(
          'INSERT INTO financial_operations(command_id,request_hash,kind,customer_id,booking_id,actor_id,reason) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
          [randomUUID(), 'historical-fixture', kind, customerId, bookingId, actor, reason],
        )
      ).rows[0].id;
    }
    async function terms(bookingId, revision, price) {
      const snapshot = {
        finalTotalRub: price,
        periods: [
          {
            pricingGroup: { code: 'economy' },
            tariffSnapshot: { groups: [{ code: 'economy', category: 'passenger' }] },
          },
        ],
      };
      const quote = (
        await db.pool.query(
          "INSERT INTO pricing_quotes(created_by,confirmed_by,confirmed_at,confirmed_overrides,version,expires_at,input,snapshot) VALUES ($1,$1,now(),'{}',2,now()+interval '1 day','{}',$2) RETURNING id",
          [actor, snapshot],
        )
      ).rows[0].id;
      return (
        await db.pool.query(
          "INSERT INTO booking_terms(booking_id,revision,quote_id,snapshot,reason,created_by) VALUES ($1,$2,$3,$4,'Historical terms',$5) RETURNING id",
          [bookingId, revision, quote, snapshot, actor],
        )
      ).rows[0].id;
    }
    // Only disposable historical SQL fixtures. No forbidden receipt API is invoked.
    async function historical({
      amount = '100',
      customerId,
      origin = 'deposit',
      method = 'cash',
      credit = false,
      price = '0',
    } = {}) {
      customerId ??= (
        await db.pool.query(
          "INSERT INTO customers(type,display_name) VALUES ('individual',$1) RETURNING id",
          [randomUUID()],
        )
      ).rows[0].id;
      const bookingId = (
        await db.pool.query(
          "INSERT INTO bookings(customer_id,start_at,end_at,target_type,target_model_id,created_by) VALUES ($1,'2080-01-01T00:00:00Z','2080-01-03T00:00:00Z','model',$2,$3) RETURNING id",
          [customerId, model, actor],
        )
      ).rows[0].id;
      await db.pool.query(
        'INSERT INTO booking_eligible_models(booking_id,model_id) VALUES ($1,$2)',
        [bookingId, model],
      );
      const termsId = await terms(bookingId, 1, price);
      const fund = method === 'bank' ? null : origin === 'rent' ? 'operating_cash' : 'deposit_pool';
      const receipt = await operation(
        origin === 'rent' ? 'rent_payment' : 'deposit_receipt',
        customerId,
        bookingId,
      );
      const lotId = (
        await db.pool.query(
          'INSERT INTO finance_lots(customer_id,original_operation_id,origin,method) VALUES ($1,$2,$3,$4) RETURNING id',
          [customerId, receipt, origin, method],
        )
      ).rows[0].id;
      await db.pool.query(
        'INSERT INTO finance_allocations(operation_id,lot_id,bucket,booking_id,amount_rub,fund) VALUES ($1,$2,$3,$4,$5,$6)',
        [receipt, lotId, origin, bookingId, amount, fund],
      );
      await db.pool.query(
        'INSERT INTO finance_external(operation_id,method,amount_rub) VALUES ($1,$2,$3)',
        [receipt, method, amount],
      );
      if (fund)
        await db.pool.query(
          'INSERT INTO finance_fund_entries(operation_id,fund,amount_rub) VALUES ($1,$2,$3)',
          [receipt, fund, amount],
        );
      if (credit) {
        const release = await operation('to_credit', customerId, bookingId);
        await db.pool.query(
          "INSERT INTO finance_allocations(operation_id,lot_id,bucket,booking_id,amount_rub,fund) VALUES ($1,$2,$3,$4,$5,$6),($1,$2,'credit',NULL,$7,$6)",
          [release, lotId, origin, bookingId, (-BigInt(amount)).toString(), fund, amount],
        );
      }
      return {
        customerId,
        bookingId,
        termsId,
        receipt,
        lotId,
        method,
        fund,
        source: {
          lotId,
          bucket: credit ? 'credit' : origin,
          bookingId: credit ? null : bookingId,
          fund,
          amountRub: amount,
        },
      };
    }
    const refund = (fixture, amountRub = fixture.source.amountRub) => ({
      kind: 'refund',
      customerId: fixture.customerId,
      ...(fixture.source.bookingId === null
        ? {}
        : { bookingId: fixture.bookingId, expectedVersion: 1 }),
      method: fixture.method,
      reason: 'Regression refund',
      sources: [{ ...fixture.source, amountRub }],
    });
    const sourceState = (customerId) => db.transaction((c) => ledger.sources(c, customerId));
    const summary = (bookingId) => db.transaction((c) => ledger.bookingSummary(c, bookingId));
    const fundState = () => db.transaction(ledger.funds);
    const trace = [];
    let recording = false;
    let completed = 0;
    const wrapped = new WeakSet();
    // Observe real driver promises; never substitute SQL results or transactions.
    db.pool.on('acquire', (client) => {
      if (wrapped.has(client)) return;
      wrapped.add(client);
      const query = client.query;
      client.query = function (...args) {
        const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text;
        const event = recording ? { sql, pid: client.processID, values: args[1] } : undefined;
        if (event) trace.push(event);
        const result = query.apply(this, args);
        if (!event || !result?.then) return result;
        return result.then(
          (value) => {
            event.ok = true;
            event.rowCount = value.rowCount;
            event.completed = ++completed;
            return value;
          },
          (error) => {
            event.code = error.code;
            throw error;
          },
        );
      };
    });
    async function observe(work) {
      trace.length = 0;
      recording = true;
      try {
        return await work();
      } finally {
        recording = false;
      }
    }
    async function waitFor(predicate) {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        if (await predicate()) return;
        await delay(10);
      }
      assert.fail('Timed out observing actual PostgreSQL lock queue');
    }
    async function orderedRace(first, second) {
      const blocker = await db.pool.connect();
      let results;
      try {
        await blocker.query('BEGIN');
        await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended('crm:schedule',0))");
        await observe(async () => {
          const scheduleRequests = () =>
            trace.filter((event) => event.sql.includes("hashtextextended('crm:schedule',0)"));
          const waiting = async (index) => {
            const event = scheduleRequests()[index];
            if (!event) return false;
            return (
              (
                await db.pool.query(
                  "SELECT 1 FROM pg_locks w JOIN pg_locks b ON w.locktype=b.locktype AND w.classid=b.classid AND w.objid=b.objid AND w.objsubid=b.objsubid WHERE w.locktype='advisory' AND NOT w.granted AND b.granted AND w.pid=$1 AND b.pid=$2",
                  [event.pid, blocker.processID],
                )
              ).rowCount === 1
            );
          };
          const a = Promise.allSettled([first()]);
          let b;
          try {
            await waitFor(() => waiting(0));
            b = Promise.allSettled([second()]);
            await waitFor(() => waiting(1));
          } finally {
            await blocker.query('COMMIT');
            results = [...(await a), ...(b ? await b : [])];
          }
          const acquired = scheduleRequests()
            .filter((event) => event.ok)
            .sort((a, b) => a.completed - b.completed);
          assert.equal(acquired.length, 2);
          // pg_locks proved the queue before releasing the blocker, rather than Promise ordering.
          assert.equal(acquired[0].pid, scheduleRequests()[0].pid);
        });
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
      }
      return results;
    }
    async function probes() {
      await db.pool.query('CREATE SCHEMA stage17');
      for (const table of [...probeTables, 'fund_versions'])
        await db.pool.query('CREATE SEQUENCE stage17.seen_' + table);
      await db.pool.query(
        "CREATE FUNCTION stage17.observe_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM nextval(('stage17.seen_' || TG_TABLE_NAME)::regclass); RETURN NEW; END $$",
      );
      for (const table of probeTables)
        await db.pool.query(
          'CREATE TRIGGER stage17_observe AFTER INSERT ON ' +
            table +
            ' FOR EACH ROW EXECUTE FUNCTION stage17.observe_insert()',
        );
      await db.pool.query(
        "CREATE FUNCTION stage17.observe_version() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM nextval('stage17.seen_fund_versions'); RETURN NEW; END $$",
      );
      await db.pool.query(
        'CREATE TRIGGER stage17_observe AFTER UPDATE ON finance_funds FOR EACH ROW EXECUTE FUNCTION stage17.observe_version()',
      );
    }
    async function counts() {
      const result = {};
      for (const table of [...probeTables, 'fund_versions']) {
        const row = (
          await db.pool.query('SELECT last_value::text, is_called FROM stage17.seen_' + table)
        ).rows[0];
        result[table] = row.is_called ? Number(row.last_value) : 0;
      }
      return result;
    }
    async function fault(sqlstate, failures) {
      assert.match(sqlstate, /^[A-Z0-9]{5}$/);
      assert.ok(Number.isInteger(failures) && failures >= 0);
      await db.pool.query('CREATE SEQUENCE stage17.attempts');
      await db.pool.query(
        "CREATE FUNCTION stage17.fail_result() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF nextval('stage17.attempts') <= " +
          failures +
          " THEN RAISE EXCEPTION 'Stage 17 result fault' USING ERRCODE='" +
          sqlstate +
          "'; END IF; RETURN NEW; END $$",
      );
      await db.pool.query(
        "CREATE TRIGGER stage17_fail BEFORE INSERT ON idempotency_records FOR EACH ROW WHEN (NEW.command='finance.post') EXECUTE FUNCTION stage17.fail_result()",
      );
    }
    await work({
      db,
      actor,
      request,
      post,
      lookup,
      snapshot,
      historical,
      terms,
      operation,
      refund,
      summary,
      sourceState,
      fundState,
      observe,
      trace,
      orderedRace,
      probes,
      counts,
      fault,
    });
  } finally {
    if (close) await close();
    assert.match(name, /^crm_finance_regression_test_[a-f0-9]{16}$/);
    await admin.query('DROP DATABASE IF EXISTS "' + name + '" WITH (FORCE)');
    await admin.end();
  }
}

function onlyAppends(before, after, allowed) {
  for (const table of Object.keys(before)) {
    if (!allowed.includes(table)) assert.deepEqual(after[table], before[table], table);
    else if (table !== 'finance_funds')
      for (const row of before[table])
        assert.deepEqual(
          after[table].find((item) =>
            row.id === undefined
              ? JSON.stringify(item) === JSON.stringify(row)
              : item.id === row.id,
          ),
          row,
          table + ' immutable existing row',
        );
  }
}

function singleEffects(before, after, id, { allocations = 1, funds = 1, external = 1 } = {}) {
  const allowed = [
    'financial_operations',
    'finance_allocations',
    'finance_fund_entries',
    'finance_funds',
    'finance_external',
    'audit_logs',
    'outbox_jobs',
    'idempotency_records',
  ];
  onlyAppends(before, after, allowed);
  for (const [table, count] of Object.entries({
    financial_operations: 1,
    finance_allocations: allocations,
    finance_fund_entries: funds,
    finance_external: external,
    audit_logs: 1,
    outbox_jobs: 1,
    idempotency_records: 1,
  }))
    assert.equal(after[table].length - before[table].length, count, table);
  assert.equal(
    after.audit_logs.filter(
      (row) => row.entity_type === 'financial_operation' && row.entity_id === id,
    ).length,
    1,
  );
  assert.equal(after.outbox_jobs.filter((row) => row.business_key === 'finance:' + id).length, 1);
  assert.equal(after.idempotency_records.filter((row) => row.result.id === id).length, 1);
  const newEntries = after.finance_fund_entries.filter(
    (row) => !before.finance_fund_entries.some((old) => old.id === row.id),
  );
  assert.equal(after.finance_funds.length, before.finance_funds.length);
  for (const fund of before.finance_funds) {
    assert.deepEqual(
      after.finance_funds.find((row) => row.id === fund.id),
      { ...fund, version: fund.version + newEntries.filter((row) => row.fund === fund.id).length },
    );
  }
  for (const table of ['finance_allocations', 'finance_fund_entries', 'finance_external']) {
    const added = after[table].filter((row) => !before[table].some((old) => old.id === row.id));
    assert.ok(
      added.every((row) => row.operation_id === id),
      table + ' belongs to the sole committed operation',
    );
  }
}

module.exports = { withFinance, code, onlyAppends, singleEffects, moneyTables };
