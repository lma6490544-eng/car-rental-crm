const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { Pool } = require('pg');
const { drizzle } = require('drizzle-orm/node-postgres');
const { migrate } = require('drizzle-orm/node-postgres/migrator');
const { trackPoolDisconnects } = require('./close-test-pool.cjs');
require('dotenv').config({ path: path.resolve(__dirname, '../../../../.env'), quiet: true });
const adminUrl = process.env.DATABASE_URL;

// Synthetic history only: never call a receipt endpoint or modify an existing row.
async function historicalSource(
  f,
  {
    origin = 'deposit',
    method = 'cash',
    fund = 'deposit_pool',
    backingFund = fund,
    customerId,
    bookingId,
  } = {},
) {
  customerId ??= (
    await f.db.pool.query(
      "INSERT INTO customers(type,display_name) VALUES ('individual',$1) RETURNING id",
      [randomUUID()],
    )
  ).rows[0].id;
  if (!bookingId) {
    const model = (await f.db.pool.query('SELECT id FROM vehicle_models ORDER BY id LIMIT 1'))
      .rows[0].id;
    bookingId = (
      await f.db.pool.query(
        "INSERT INTO bookings(customer_id,start_at,end_at,target_type,target_model_id,created_by) VALUES ($1,'2080-01-01','2080-01-03','model',$2,$3) RETURNING id",
        [customerId, model, f.actor],
      )
    ).rows[0].id;
    await f.terms(bookingId, 1, '0');
  }
  const receipt = await f.operation(
    origin === 'rent' ? 'rent_payment' : 'deposit_receipt',
    customerId,
    bookingId,
  );
  const lotId = (
    await f.db.pool.query(
      'INSERT INTO finance_lots(customer_id,original_operation_id,origin,method) VALUES ($1,$2,$3,$4) RETURNING id',
      [customerId, receipt, origin, method],
    )
  ).rows[0].id;
  await f.db.pool.query(
    'INSERT INTO finance_allocations(operation_id,lot_id,bucket,booking_id,amount_rub,fund) VALUES ($1,$2,$3,$4,100,$5)',
    [receipt, lotId, origin, bookingId, fund],
  );
  await f.db.pool.query(
    'INSERT INTO finance_external(operation_id,method,amount_rub) VALUES ($1,$2,100)',
    [receipt, method],
  );
  if (backingFund !== null)
    await f.db.pool.query(
      'INSERT INTO finance_fund_entries(operation_id,fund,amount_rub) VALUES ($1,$2,100)',
      [receipt, backingFund],
    );
  return {
    customerId,
    bookingId,
    receipt,
    lotId,
    method,
    source: { lotId, bucket: origin, bookingId, fund, amountRub: '100' },
  };
}

function reads(f) {
  const { FinanceService } = require('../../dist/finance/finance.service');
  const { FinanceController } = require('../../dist/finance/finance.controller');
  const { CommandsService } = require('../../dist/platform/commands.service');
  const { financeInput } = require('../../dist/finance/finance.dto');
  const finance = new FinanceService(f.db, new CommandsService(f.db));
  const controller = new FinanceController(finance);
  return {
    controller,
    // Inspect the actual plan under the normal lock and DTO, without replacing it.
    plan: (raw) =>
      f.db.transaction(async (c) => {
        const input = financeInput.parse(raw);
        await finance.lock(c, input);
        return finance.plan(c, input);
      }),
  };
}

const validFundKeys = (plan) =>
  Object.keys(plan.funds).every((key) => ['operating_cash', 'deposit_pool'].includes(key));
const balance = (state, id) => BigInt(state.items.find((row) => row.id === id).balanceRub);
const sourceFor = async (f, h) =>
  (await f.sourceState(h.customerId)).filter((row) => row.lotId === h.lotId);
const inverse = (id) => ({
  kind: 'reversal',
  operationId: id,
  reason: 'Nullable fund diagnostic inverse',
});
const sqlError = (code) => (error) => {
  assert.equal(error.code, code);
  return true;
};

// Apply real 0000..0010, insert schema-valid pre-fund credit, then apply 0011.
// This proves a possible migration path, not the presence of production history.
async function withMigratedHistory(work) {
  const name = 'crm_nullable_migration_test_' + randomBytes(8).toString('hex');
  const admin = new Pool({ connectionString: adminUrl });
  const temporaryRoot = path.resolve(os.tmpdir());
  const baseline = fs.mkdtempSync(path.join(temporaryRoot, 'crm-stage20-migrations-'));
  let close;
  try {
    await admin.query('CREATE DATABASE "' + name + '"');
    const url = new URL(adminUrl);
    url.pathname = '/' + name;
    process.env.DATABASE_URL = url.toString();
    const { DatabaseService } = require('../../dist/database.service');
    const db = new DatabaseService();
    close = trackPoolDisconnects(db.pool);
    const migrations = path.resolve(__dirname, '../../drizzle');
    const journal = JSON.parse(
      fs.readFileSync(path.join(migrations, 'meta/_journal.json'), 'utf8'),
    );
    const entries = journal.entries.filter((entry) => entry.idx <= 10);
    fs.mkdirSync(path.join(baseline, 'meta'));
    for (const entry of entries)
      fs.copyFileSync(
        path.join(migrations, entry.tag + '.sql'),
        path.join(baseline, entry.tag + '.sql'),
      );
    fs.writeFileSync(
      path.join(baseline, 'meta/_journal.json'),
      JSON.stringify({ ...journal, entries }),
    );
    await migrate(drizzle(db.pool), { migrationsFolder: baseline });
    assert.equal(
      (
        await db.pool.query(
          "SELECT 1 FROM information_schema.columns WHERE table_name='finance_allocations' AND column_name='fund'",
        )
      ).rowCount,
      0,
    );
    const customerId = (
      await db.pool.query(
        "INSERT INTO customers(type,display_name) VALUES ('individual','Pre-fund synthetic history') RETURNING id",
      )
    ).rows[0].id;
    const receipt = (
      await db.pool.query(
        "INSERT INTO financial_operations(command_id,request_hash,kind,customer_id,reason) VALUES ($1,'fixture','rent_payment',$2,'Pre-fund history') RETURNING id",
        [randomUUID(), customerId],
      )
    ).rows[0].id;
    const lotId = (
      await db.pool.query(
        "INSERT INTO finance_lots(customer_id,original_operation_id,origin,method) VALUES ($1,$2,'rent','cash') RETURNING id",
        [customerId, receipt],
      )
    ).rows[0].id;
    await db.pool.query(
      "INSERT INTO finance_allocations(operation_id,lot_id,bucket,amount_rub) VALUES ($1,$2,'credit',100)",
      [receipt, lotId],
    );
    await db.pool.query(
      "INSERT INTO finance_external(operation_id,method,amount_rub) VALUES ($1,'cash',100)",
      [receipt],
    );
    await migrate(drizzle(db.pool), { migrationsFolder: migrations });
    await work({ db, customerId, receipt, lotId });
  } finally {
    if (close) await close();
    assert.match(name, /^crm_nullable_migration_test_[a-f0-9]{16}$/);
    await admin.query('DROP DATABASE IF EXISTS "' + name + '" WITH (FORCE)');
    await admin.end();
    assert.equal(path.dirname(path.resolve(baseline)), temporaryRoot);
    assert.ok(path.basename(baseline).startsWith('crm-stage20-migrations-'));
    fs.rmSync(baseline, { recursive: true });
  }
}

async function withHttpApi(f, work) {
  const { passwordHash } = require('../../dist/platform/security');
  const password = 'Nullable-' + randomBytes(16).toString('hex');
  await f.db.pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [
    await passwordHash(password),
    f.actor,
  ]);
  const port = await new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const value = server.address().port;
      server.close(() => resolve(value));
    });
  });
  const origin = 'http://127.0.0.1:' + port;
  const child = spawn(process.execPath, [path.resolve(__dirname, '../../dist/main.js')], {
    cwd: path.resolve(__dirname, '../..'),
    env: {
      ...process.env,
      DATABASE_URL: f.db.pool.options.connectionString,
      NODE_ENV: 'test',
      API_PORT: String(port),
      APP_ORIGINS: origin,
    },
    windowsHide: true,
    stdio: 'ignore',
  });
  const exited = once(child, 'exit');
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        ready = (await fetch(origin + '/api/v1/health')).ok;
      } catch {
        ready = false;
      }
      if (ready) break;
      await delay(100);
    }
    assert.equal(ready, true, 'isolated HTTP API ready');
    const login = await fetch(origin + '/api/v1/auth/login', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ login: 'regression', password }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const { csrfToken } = await login.json();
    const call = async (endpoint, body, key = randomUUID()) => {
      const response = await fetch(origin + '/api/v1/' + endpoint, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          origin,
          'content-type': 'application/json',
          cookie,
          'x-csrf-token': csrfToken,
          'idempotency-key': key,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    };
    await work(call);
  } finally {
    child.kill();
    await exited;
  }
}

module.exports = {
  withHttpApi,
  historicalSource,
  reads,
  validFundKeys,
  balance,
  sourceFor,
  inverse,
  sqlError,
  withMigratedHistory,
};
