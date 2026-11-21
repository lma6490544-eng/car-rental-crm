const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const path = require('node:path');
const { Pool } = require('pg');
const { drizzle } = require('drizzle-orm/node-postgres');
const { migrate } = require('drizzle-orm/node-postgres/migrator');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env'), quiet: true });

test('Finance integrity audit: real source races, late rollback, warning and exact money', async (t) => {
  const name = 'crm_finance_audit_test_' + randomBytes(8).toString('hex');
  const url = new URL(process.env.DATABASE_URL);
  const admin = new Pool({ connectionString: url.toString() });
  let db;
  t.after(async () => {
    if (db) await db.pool.end();
    assert.match(name, /^crm_finance_audit_test_[a-f0-9]{16}$/);
    await admin.query('DROP DATABASE IF EXISTS "' + name + '" WITH (FORCE)');
    await admin.end();
  });
  await admin.query('CREATE DATABASE "' + name + '"');
  url.pathname = '/' + name;
  process.env.DATABASE_URL = url.toString();
  const { DatabaseService } = require('../dist/database.service');
  const { CommandsService } = require('../dist/platform/commands.service');
  const { FinanceService, financeInput } = require('../dist/finance/finance.service');
  const { FinanceController } = require('../dist/finance/finance.controller');
  const { funds, sources } = require('../dist/finance/ledger');
  db = new DatabaseService();
  await migrate(drizzle(db.pool), { migrationsFolder: path.resolve(__dirname, '../drizzle') });
  const commands = new CommandsService(db);
  const finance = new FinanceService(db, commands);
  const controller = new FinanceController(finance);
  const actor = (
    await db.pool.query(
      "INSERT INTO users(full_name,login,password_hash,role) VALUES ('Audit','audit','unused','manager') RETURNING id",
    )
  ).rows[0].id;
  await db.pool.query(
    "INSERT INTO sessions(user_id,token_hash,expires_at) VALUES ($1,'audit-session',now()+interval '1 hour')",
    [actor],
  );
  const request = () => ({
    headers: { 'idempotency-key': randomUUID() },
    requestId: randomUUID(),
    auth: { user: { id: actor }, tokenHash: 'audit-session' },
  });
  const group = (await db.pool.query("SELECT id FROM pricing_groups WHERE tariff_code='economy'"))
    .rows[0].id;
  const brand = (
    await db.pool.query("INSERT INTO vehicle_brands(name) VALUES ('Audit') RETURNING id")
  ).rows[0].id;
  const model = (
    await db.pool.query(
      "INSERT INTO vehicle_models(brand_id,name,pricing_group_id) VALUES ($1,'Audit',$2) RETURNING id",
      [brand, group],
    )
  ).rows[0].id;
  const tables = (
    await db.pool.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
    )
  ).rows.map((x) => x.tablename);
  const snapshot = async () => {
    const result = {};
    for (const table of tables) {
      assert.match(table, /^[a-z_][a-z0-9_]*$/);
      result[table] = (
        await db.pool.query(
          "SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t::text),'[]'::jsonb) AS rows FROM \"" +
            table +
            '" t',
        )
      ).rows[0].rows;
    }
    return result;
  };
  // Historical receipts exist only as SQL fixtures in this disposable database.
  // No current application receipt gate is bypassed or changed.
  const historical = async (amountRub = '100', method = 'cash', backed = true) =>
    db.transaction(async (c) => {
      const customerId = (
        await c.query(
          "INSERT INTO customers(type,display_name) VALUES ('individual',$1) RETURNING id",
          [randomUUID()],
        )
      ).rows[0].id;
      const bookingId = (
        await c.query(
          "INSERT INTO bookings(customer_id,start_at,end_at,target_type,target_model_id,created_by) VALUES ($1,'2080-01-01','2080-01-03','model',$2,$3) RETURNING id",
          [customerId, model, actor],
        )
      ).rows[0].id;
      const bucket = method === 'bank' ? 'rent' : 'deposit';
      const fund = method === 'bank' ? null : 'deposit_pool';
      const op = (
        await c.query(
          "INSERT INTO financial_operations(command_id,request_hash,kind,customer_id,booking_id,actor_id,reason) VALUES ($1,'fixture',$2,$3,$4,$5,'Historical') RETURNING id",
          [
            randomUUID(),
            bucket === 'rent' ? 'rent_payment' : 'deposit_receipt',
            customerId,
            bookingId,
            actor,
          ],
        )
      ).rows[0].id;
      const lotId = (
        await c.query(
          'INSERT INTO finance_lots(customer_id,original_operation_id,origin,method) VALUES ($1,$2,$3,$4) RETURNING id',
          [customerId, op, bucket, method],
        )
      ).rows[0].id;
      await c.query(
        'INSERT INTO finance_allocations(operation_id,lot_id,bucket,booking_id,amount_rub,fund) VALUES ($1,$2,$3,$4,$5,$6)',
        [op, lotId, bucket, bookingId, amountRub, fund],
      );
      await c.query(
        'INSERT INTO finance_external(operation_id,method,amount_rub) VALUES ($1,$2,$3)',
        [op, method, amountRub],
      );
      if (fund && backed)
        await c.query(
          'INSERT INTO finance_fund_entries(operation_id,fund,amount_rub) VALUES ($1,$2,$3)',
          [op, fund, amountRub],
        );
      const source = { lotId, bucket, bookingId, fund, amountRub };
      return { customerId, bookingId, expectedVersion: 1, source, method, op };
    });
  const refund = (f, amountRub = f.source.amountRub) => ({
    kind: 'refund',
    customerId: f.customerId,
    bookingId: f.bookingId,
    expectedVersion: 1,
    method: f.method,
    reason: 'Audit refund',
    sources: [{ ...f.source, amountRub }],
  });
  const post = (body, r = request()) => controller.post(body, r);
  const code = (expected) => (error) => error.getResponse?.().code === expected;
  const sourceState = (customerId) => db.transaction((c) => sources(c, customerId));
  const fundState = () => db.transaction(funds);
  const oneWinner = (results, errorCode) => {
    assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
    const loser = results.find((x) => x.status === 'rejected');
    assert.equal(loser.reason.getResponse().code, errorCode);
    return results.find((x) => x.status === 'fulfilled').value;
  };
  await t.test(
    'distinct-key simultaneous refunds cannot overspend one source; refund races release',
    async () => {
      for (const reverseOrder of [false, true]) {
        const f = await historical();
        const a = () => post(refund(f, '70'));
        const b = () => post(refund(f, '80'));
        oneWinner(
          await Promise.allSettled(reverseOrder ? [b(), a()] : [a(), b()]),
          'INSUFFICIENT_SOURCE',
        );
        const remaining = BigInt((await sourceState(f.customerId))[0].availableRub);
        assert.ok(remaining === 20n || remaining === 30n);
        const external = (
          await db.pool.query(
            'SELECT sum(amount_rub)::text n FROM finance_external e JOIN financial_operations o ON o.id=e.operation_id WHERE o.customer_id=$1',
            [f.customerId],
          )
        ).rows[0].n;
        assert.equal(BigInt(external), remaining);
        const g = await historical();
        const release = {
          kind: 'to_credit',
          customerId: g.customerId,
          bookingId: g.bookingId,
          expectedVersion: 1,
          reason: 'Release',
          sources: [g.source],
        };
        oneWinner(
          await Promise.allSettled(
            reverseOrder ? [post(release), post(refund(g))] : [post(refund(g)), post(release)],
          ),
          'INSUFFICIENT_SOURCE',
        );
        const state = await sourceState(g.customerId);
        assert.ok(
          state.length === 0 ||
            (state.length === 1 && state[0].bucket === 'credit' && state[0].availableRub === '100'),
        );
      }
    },
  );
  await t.test(
    'competing reversals append only one exact inverse and reject dependent source consumption',
    async () => {
      const f = await historical();
      const operation = await post(refund(f, '40'));
      oneWinner(
        await Promise.allSettled([
          post({ kind: 'reversal', operationId: operation.id, reason: 'A' }),
          post({ kind: 'reversal', operationId: operation.id, reason: 'B' }),
        ]),
        'ALREADY_REVERSED',
      );
      assert.equal((await sourceState(f.customerId))[0].availableRub, '100');
      await post(refund(f, '100'));
      const before = await snapshot();
      await assert.rejects(
        post({ kind: 'reversal', operationId: f.op, reason: 'Cannot undo consumed receipt' }),
        code('INSUFFICIENT_SOURCE'),
      );
      assert.deepEqual(await snapshot(), before);
    },
  );
  await t.test(
    'same key with competing bodies commits once and reauthorization precedes cached replay',
    async () => {
      const f = await historical();
      const r = request();
      const bodies = [refund(f, '10'), refund(f, '20')];
      const results = await Promise.allSettled(bodies.map((body) => post(body, r)));
      const winner = oneWinner(results, 'IDEMPOTENCY_KEY_REUSED');
      const body = bodies[results.findIndex((x) => x.status === 'fulfilled')];
      const before = await snapshot();
      assert.deepEqual(await post(body, r), winner);
      assert.deepEqual(await snapshot(), before);
      await db.pool.query("UPDATE sessions SET revoked_at=now() WHERE token_hash='audit-session'");
      await assert.rejects(post(body, r), code('UNAUTHENTICATED'));
      await db.pool.query("UPDATE sessions SET revoked_at=NULL WHERE token_hash='audit-session'");
      assert.deepEqual(await snapshot(), before);
    },
  );
  await t.test(
    'late audit and outbox failures roll back every public table; same key retries successfully',
    async () => {
      for (const target of ['audit_logs', 'outbox_jobs']) {
        const f = await historical();
        const body = refund(f, '30');
        const r = request();
        await db.pool.query(
          "CREATE OR REPLACE FUNCTION audit_finance_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit fixture failure' USING ERRCODE='P0001'; END $$",
        );
        const condition =
          target === 'audit_logs' ? "NEW.action='finance.refund'" : "NEW.kind='finance.posted'";
        await db.pool.query(
          'CREATE TRIGGER audit_finance_fail BEFORE INSERT ON ' +
            target +
            ' FOR EACH ROW WHEN (' +
            condition +
            ') EXECUTE FUNCTION audit_finance_fail()',
        );
        const before = await snapshot();
        try {
          for (let i = 0; i < 2; i++) {
            await assert.rejects(post(body, r), (error) => error.code === 'P0001');
            assert.deepEqual(await snapshot(), before, target + ' full rollback');
          }
        } finally {
          await db.pool.query('DROP TRIGGER audit_finance_fail ON ' + target);
        }
        const result = await post(body, r);
        const after = await snapshot();
        assert.deepEqual(await post(body, r), result);
        assert.deepEqual(await snapshot(), after);
        assert.equal((await sourceState(f.customerId))[0].availableRub, '70');
        assert.equal(
          (
            await db.pool.query(
              "SELECT count(*)::int n FROM audit_logs WHERE entity_type='financial_operation' AND entity_id=$1",
              [result.id],
            )
          ).rows[0].n,
          1,
        );
        assert.equal(
          (
            await db.pool.query('SELECT count(*)::int n FROM outbox_jobs WHERE business_key=$1', [
              'finance:' + result.id,
            ])
          ).rows[0].n,
          1,
        );
      }
    },
  );
  await t.test(
    'physical shortfall requires current acknowledgement; another fund commit invalidates token',
    async () => {
      const backing = await historical('1');
      const state = await fundState();
      const balance = BigInt(state.items.find((x) => x.id === 'deposit_pool').balanceRub);
      // Underfunding is a permitted historical state, not a new expense endpoint.
      const f = await historical((balance + 100n).toString(), 'cash', false);
      const body = refund(f);
      const before = await snapshot();
      const preview = await controller.preview(body);
      assert.equal(preview.negative.length, 1);
      assert.equal(preview.negative[0].afterRub, '-100');
      assert.deepEqual(await snapshot(), before, 'preview writes nothing');
      await assert.rejects(post(body), code('FUND_SHORTFALL_CONFIRMATION'));
      assert.deepEqual(await snapshot(), before);
      await post(refund(backing));
      const changed = await snapshot();
      await assert.rejects(
        post({ ...body, shortfallAcknowledged: true, warningToken: preview.token }),
        code('FUND_SHORTFALL_CONFIRMATION'),
      );
      assert.deepEqual(await snapshot(), changed);
      const current = await controller.preview(body);
      const result = await post({
        ...body,
        shortfallAcknowledged: true,
        warningToken: current.token,
      });
      assert.equal(
        (await fundState()).items.find((x) => x.id === 'deposit_pool').balanceRub,
        '-101',
      );
      const event = (
        await db.pool.query(
          "SELECT details FROM audit_logs WHERE entity_type='financial_operation' AND entity_id=$1",
          [result.id],
        )
      ).rows[0].details;
      assert.equal(event.shortfallAcknowledged, true);
      assert.equal(event.negativeFunds[0].afterRub, '-101');
      // Restore backing through the supported inverse, preserving all posted history.
      await post({
        kind: 'reversal',
        operationId: result.id,
        reason: 'Restore after audit scenario',
      });
    },
  );
  await t.test(
    'BigInt partial refund and inverse preserve exact strings; DTO rejects overflow/fractions',
    async () => {
      const f = await historical('9007199254740993', 'bank');
      const operation = await post(refund(f, '9007199254740991'));
      assert.equal((await sourceState(f.customerId))[0].availableRub, '2');
      const journal = await controller.customer(String(f.customerId));
      assert.equal(journal.items[0].external[0].amountRub, '-9007199254740991');
      await post({ kind: 'reversal', operationId: operation.id, reason: 'Exact inverse' });
      assert.equal((await sourceState(f.customerId))[0].availableRub, '9007199254740993');
      assert.equal(
        financeInput.safeParse({
          kind: 'initial',
          fund: 'operating_cash',
          amountRub: '9223372036854775807',
          reason: 'Boundary',
        }).success,
        true,
      );
      for (const amountRub of ['9223372036854775808', '1.5', '-1', '01'])
        assert.equal(
          financeInput.safeParse({
            kind: 'initial',
            fund: 'operating_cash',
            amountRub,
            reason: 'Invalid',
          }).success,
          false,
        );
    },
  );
  await t.test(
    'read projections preserve all tables and SQL rejects UPDATE/TRUNCATE of posted history',
    async () => {
      const f = await historical('10', 'bank');
      const before = await snapshot();
      await controller.get({});
      await controller.booking(String(f.bookingId));
      await controller.customer(String(f.customerId));
      await controller.preview(refund(f, '1'));
      assert.deepEqual(await snapshot(), before);
      const immutable = [
        'financial_operations',
        'finance_charges',
        'finance_external',
        'finance_lots',
        'finance_allocations',
        'finance_fund_entries',
      ];
      for (const table of immutable)
        await assert.rejects(
          db.pool.query('UPDATE ' + table + ' SET id=id WHERE false'),
          (error) => error.code === '23514',
        );
      await assert.rejects(
        db.pool.query('TRUNCATE ' + immutable.join(',')),
        (error) => error.code === '23514',
      );
      assert.deepEqual(await snapshot(), before);
    },
  );
  await t.test(
    'real HTTP financial contract preserves guards, DTO errors, posting and recovery',
    async () => {
      const net = require('node:net');
      const { spawn } = require('node:child_process');
      const { passwordHash } = require('../dist/platform/security');
      const password = 'Audit-' + randomBytes(16).toString('hex');
      await db.pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [
        await passwordHash(password),
        actor,
      ]);
      const port = await new Promise((resolve) => {
        const server = net.createServer();
        server.listen(0, '127.0.0.1', () => {
          const value = server.address().port;
          server.close(() => resolve(value));
        });
      });
      const origin = 'http://127.0.0.1:' + port;
      const child = spawn(process.execPath, [path.resolve(__dirname, '../dist/main.js')], {
        cwd: path.resolve(__dirname, '..'),
        env: {
          ...process.env,
          NODE_ENV: 'test',
          DATABASE_URL: url.toString(),
          API_PORT: String(port),
          APP_ORIGINS: origin,
        },
        windowsHide: true,
        stdio: 'ignore',
      });
      try {
        let ready = false;
        for (let i = 0; i < 100; i++) {
          try {
            if ((await fetch(origin + '/api/v1/health')).ok) {
              ready = true;
              break;
            }
          } catch {}
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.ok(ready, 'isolated HTTP API ready');
        const login = await fetch(origin + '/api/v1/auth/login', {
          method: 'POST',
          headers: { origin, 'content-type': 'application/json' },
          body: JSON.stringify({ login: 'audit', password }),
        });
        assert.equal(login.status, 200);
        const cookie = login.headers.get('set-cookie').split(';')[0];
        const { csrfToken } = await login.json();
        const call = async (endpoint, body, headers = {}) => {
          const response = await fetch(origin + '/api/v1/' + endpoint, {
            method: body === undefined ? 'GET' : 'POST',
            headers: {
              origin,
              'content-type': 'application/json',
              cookie,
              'x-csrf-token': csrfToken,
              ...headers,
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
          return { status: response.status, body: await response.json() };
        };
        const f = await historical('10', 'bank');
        const body = refund(f, '3');
        const before = await snapshot();
        const preview = await call('financial-operations/preview', body);
        assert.equal(preview.status, 201);
        assert.match(preview.body.token, /^[a-f0-9]{64}$/);
        assert.deepEqual(preview.body.negative, []);
        const invalid = await call('financial-operations', { ...body, extra: true });
        assert.equal(invalid.status, 400);
        assert.equal(invalid.body.code, 'VALIDATION_ERROR');
        const missingKey = await call('financial-operations', body);
        assert.equal(missingKey.status, 400);
        assert.equal(missingKey.body.code, 'IDEMPOTENCY_KEY_REQUIRED');
        const forbidden = {
          kind: 'rent_payment',
          customerId: f.customerId,
          bookingId: f.bookingId,
          expectedVersion: 1,
          amountRub: '3',
          method: 'bank',
          reason: 'Before issuance',
        };
        for (const endpoint of ['financial-operations/preview', 'financial-operations']) {
          const result = await call(endpoint, forbidden, { 'idempotency-key': randomUUID() });
          assert.equal(result.status, 422);
          assert.equal(result.body.code, 'RENTAL_NOT_ISSUED');
        }
        const csrf = await call('financial-operations/preview', body, {
          'x-csrf-token': 'invalid',
        });
        assert.equal(csrf.status, 403);
        assert.equal(csrf.body.code, 'CSRF_REJECTED');
        const anonymous = await call('financial-operations/preview', body, { cookie: '' });
        assert.equal(anonymous.status, 401);
        assert.equal(anonymous.body.code, 'UNAUTHENTICATED');
        assert.deepEqual(
          await snapshot(),
          before,
          'preview and rejected HTTP calls have no effects',
        );
        const key = randomUUID();
        const posted = await call('financial-operations', body, { 'idempotency-key': key });
        assert.equal(posted.status, 201);
        assert.equal(typeof posted.body.id, 'number');
        assert.deepEqual(
          await call('financial-operations', body, { 'idempotency-key': key }),
          posted,
        );
        const conflict = await call(
          'financial-operations',
          { ...body, reason: 'Other' },
          { 'idempotency-key': key },
        );
        assert.equal(conflict.status, 409);
        assert.equal(conflict.body.code, 'IDEMPOTENCY_KEY_REUSED');
        await db.pool.query(
          "DELETE FROM idempotency_records WHERE command='finance.post' AND key=$1",
          [key],
        );
        const recovered = await call('operations/by-key?command=finance.post&key=' + key);
        assert.equal(recovered.status, 200);
        assert.deepEqual(recovered.body, { status: 'completed', result: posted.body });
        const stable = await snapshot();
        assert.deepEqual(
          await call('financial-operations', body, { 'idempotency-key': key }),
          posted,
        );
        // Permanent replay recreates only the HTTP result cache; money/events stay unchanged.
        const after = await snapshot();
        delete stable.idempotency_records;
        delete after.idempotency_records;
        assert.deepEqual(after, stable);
        assert.equal((await call('finance')).status, 200);
        const summary = await call('bookings/' + f.bookingId + '/finance');
        assert.equal(summary.status, 200);
        assert.equal(summary.body.summary.coverageRub, '7');
        assert.equal(summary.body.summary.paymentsAllowed, false);
        assert.equal(summary.body.summary.debtRub, '0');
      } finally {
        const exited = new Promise((resolve) => child.once('exit', resolve));
        if (child.exitCode === null && child.signalCode === null) {
          child.kill();
          await exited;
        }
      }
    },
  );
});
