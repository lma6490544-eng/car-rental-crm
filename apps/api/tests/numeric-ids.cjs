const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { Pool, Client } = require('pg');
const { trackPoolDisconnects } = require('./helpers/close-test-pool.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env'), quiet: true });
test('populated UUID database migrates with relationships, history, sessions and results intact', async (t) => {
  const name = 'crm_ids_test_' + randomBytes(8).toString('hex');
  const url = new URL(process.env.DATABASE_URL);
  const admin = new Pool({ connectionString: url.toString() });
  url.pathname = '/' + name;
  const pool = new Pool({ connectionString: url.toString() });
  const closePool = trackPoolDisconnects(pool);
  t.after(async () => {
    try {
      await closePool();
      assert.match(name, /^crm_ids_test_[a-f0-9]{16}$/);
      await admin.query('DROP DATABASE IF EXISTS "' + name + '"');
    } finally {
      await admin.end();
    }
  });
  await admin.query('CREATE DATABASE "' + name + '"');
  const folder = path.resolve(__dirname, '../drizzle');
  for (const file of (await fs.readdir(folder)).filter((f) => /^000[0-3]_.*\.sql$/.test(f)).sort())
    await pool.query(await fs.readFile(path.join(folder, file), 'utf8'));
  const actor = randomUUID(),
    customer = randomUUID(),
    session = randomUUID(),
    audit = randomUUID(),
    key = randomUUID();
  await pool.query(
    "INSERT INTO users(id,full_name,login,password_hash,role) VALUES ($1,'Test','admin','unchanged-hash','admin')",
    [actor],
  );
  await pool.query(
    "INSERT INTO sessions(id,user_id,token_hash,expires_at) VALUES ($1,$2,'unchanged-session',now()+interval '1 day')",
    [session, actor],
  );
  await pool.query(
    "INSERT INTO customers(id,type,display_name,details) VALUES ($1,'individual','Preserved',$2)",
    [customer, JSON.stringify({ actualAddress: customer })],
  );
  await pool.query(
    "INSERT INTO audit_logs(id,actor_id,entity_id,action,request_id,details) VALUES ($1,$2,$3,'customers.updated',$4,$5)",
    [
      audit,
      actor,
      customer,
      key,
      JSON.stringify({ noteId: customer, before: { id: customer }, reason: 'keep ' + customer }),
    ],
  );
  await pool.query(
    "INSERT INTO customer_notes(customer_id,created_by,text) VALUES ($1,$2,'Note')",
    [customer, actor],
  );
  await pool.query(
    "INSERT INTO idempotency_records(actor_id,command,key,request_hash,result) VALUES ($1,'customers.create',$2,'preserved-hash',$3)",
    [actor, key, JSON.stringify({ id: customer, displayName: 'Preserved' })],
  );
  await pool.query(
    "INSERT INTO outbox_jobs(business_key,kind,payload) VALUES ($1,'customers.created',$2)",
    ['customers.created:' + customer + ':1', JSON.stringify({ id: customer })],
  );
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      await fs.readFile(path.join(folder, '0004_skinny_sharon_carter.sql'), 'utf8'),
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  const u = (await pool.query('SELECT * FROM users')).rows[0],
    c = (await pool.query('SELECT * FROM customers')).rows[0];
  assert.equal(typeof u.id, 'number');
  assert.equal(typeof c.id, 'number');
  assert.notEqual(c.id, u.id);
  assert.equal(u.password_hash, 'unchanged-hash');
  assert.equal(c.details.actualAddress, customer);
  const s = (await pool.query('SELECT * FROM sessions')).rows[0];
  assert.equal(s.user_id, u.id);
  assert.equal(s.token_hash, 'unchanged-session');
  const a = (await pool.query('SELECT * FROM audit_logs')).rows[0];
  assert.equal(a.entity_id, c.id);
  assert.equal(a.actor_id, u.id);
  assert.equal(a.request_id, key);
  assert.equal(a.details.before.id, c.id);
  assert.equal(a.details.reason, 'keep ' + customer);
  const n = (await pool.query('SELECT * FROM customer_notes')).rows[0];
  assert.equal(n.customer_id, c.id);
  assert.equal(n.created_by, u.id);
  const result = (await pool.query('SELECT * FROM idempotency_records')).rows[0];
  assert.equal(result.actor_id, u.id);
  assert.equal(result.result.id, c.id);
  assert.equal(result.key, key);
  assert.equal(result.request_hash, 'preserved-hash');
  const event = (await pool.query('SELECT * FROM outbox_jobs')).rows[0];
  assert.equal(event.payload.id, c.id);
  assert.equal(event.business_key, 'customers.created:' + c.id + ':1');
  const next = (
    await pool.query(
      "INSERT INTO customers(type,display_name) VALUES ('individual','Next') RETURNING id",
    )
  ).rows[0];
  assert.ok(next.id > c.id);
  await t.test(
    'independent identities preserve all rows and isolate audit for overlapping IDs',
    async () => {
      const tables = [
        'users',
        'sessions',
        'audit_logs',
        'idempotency_records',
        'outbox_jobs',
        'pricing_groups',
        'vehicle_brands',
        'vehicle_models',
        'equivalence_groups',
        'customers',
        'customer_notes',
        'vehicles',
        'vehicle_service_records',
      ];
      const before = {};
      for (const table of tables)
        before[table] = (await pool.query('SELECT * FROM ' + table + ' ORDER BY id')).rows;
      const migration = await pool.connect();
      try {
        await migration.query('BEGIN');
        await migration.query(
          await fs.readFile(path.join(folder, '0005_quiet_impossible_man.sql'), 'utf8'),
        );
        await migration.query('COMMIT');
      } catch (e) {
        await migration.query('ROLLBACK');
        throw e;
      } finally {
        migration.release();
      }
      for (const table of tables) {
        const rows = (await pool.query('SELECT * FROM ' + table + ' ORDER BY id')).rows;
        assert.deepEqual(
          rows.map((row) => {
            const copy = { ...row };
            if (table === 'audit_logs') delete copy.entity_type;
            return copy;
          }),
          before[table],
          table + ' preserved',
        );
        const seq = (await pool.query("SELECT pg_get_serial_sequence($1,'id') AS name", [table]))
          .rows[0].name;
        assert.equal(seq, 'public.' + table + '_id_seq');
        const generated = Number((await pool.query('SELECT nextval($1) AS id', [seq])).rows[0].id);
        assert.equal(
          generated,
          Math.max(0, ...before[table].map((row) => row.id)) + 1,
          table + ' continues independently',
        );
      }
      assert.equal(
        (await pool.query("SELECT to_regclass('public.record_id_seq') AS seq")).rows[0].seq,
        null,
      );
      assert.equal(
        (await pool.query('SELECT entity_type FROM audit_logs')).rows[0].entity_type,
        'customer',
      );
      const { audit: writeAudit } = require('../dist/platform/security.js');
      const { CatalogService } = require('../dist/catalog/catalog.service.js');
      const pricing = (
        await pool.query("INSERT INTO pricing_groups(name) VALUES ('Test') RETURNING id")
      ).rows[0].id;
      const brand = (
        await pool.query("INSERT INTO vehicle_brands(name) VALUES ('Test') RETURNING id")
      ).rows[0].id;
      const model = (
        await pool.query(
          "INSERT INTO vehicle_models(brand_id,name,pricing_group_id) VALUES ($1,'Test',$2) RETURNING id",
          [brand, pricing],
        )
      ).rows[0].id;
      await pool.query(
        "INSERT INTO vehicles(id,model_id,plate,year,body_type,current_mileage_km,next_maintenance_due_km) VALUES ($1,$2,'A001AA198',2024,'sedan',0,10000)",
        [c.id, model],
      );
      await pool.query(
        "INSERT INTO users(id,full_name,login,password_hash) VALUES ($1,'Overlap','overlap','hash')",
        [c.id],
      );
      await writeAudit(pool, u.id, 'vehicle', 'vehicles.created', c.id, randomUUID());
      await writeAudit(pool, u.id, 'user', 'users.created', c.id, randomUUID());
      const service = new CatalogService({ pool }, null);
      const customersHistory = await service.history('customers', c.id);
      const vehiclesHistory = await service.history('vehicles', c.id);
      assert.equal(customersHistory.total, 1);
      assert.deepEqual(
        customersHistory.items.map((x) => x.action),
        ['customers.updated'],
      );
      assert.equal(vehiclesHistory.total, 1);
      assert.deepEqual(
        vehiclesHistory.items.map((x) => x.action),
        ['vehicles.created'],
      );
      const inserted = await Promise.all(
        Array.from({ length: 12 }, () =>
          pool.query(
            "INSERT INTO customers(type,display_name) VALUES ('individual','Concurrent') RETURNING id",
          ),
        ),
      );
      assert.equal(new Set(inserted.map((x) => x.rows[0].id)).size, 12);
      assert.ok(inserted.every((x) => x.rows[0].id > next.id));
      const { seedCatalog } = require('../dist/catalog/seed.js');
      for (let run = 0; run < 2; run++) {
        const seedClient = await pool.connect();
        try {
          await seedClient.query('BEGIN');
          await seedCatalog(seedClient, true);
          await seedClient.query('COMMIT');
        } catch (e) {
          await seedClient.query('ROLLBACK');
          throw e;
        } finally {
          seedClient.release();
        }
      }
      for (const table of [
        'pricing_groups',
        'vehicle_brands',
        'vehicle_models',
        'equivalence_groups',
        'customers',
        'vehicles',
      ]) {
        const max = (await pool.query('SELECT max(id) AS id FROM ' + table)).rows[0].id;
        const generated = Number(
          (await pool.query("SELECT nextval(pg_get_serial_sequence($1,'id')) AS id", [table]))
            .rows[0].id,
        );
        assert.ok(generated > max, table + ' seed advances identity');
      }
    },
  );
  await t.test(
    'cleanup waits for real client disconnects before dropping the database',
    async (t) => {
      class DelayedDisconnectClient extends Client {
        end(callback) {
          // Delay only transport teardown, never SQL or application behavior.
          setTimeout(() => super.end(callback), 100);
        }
      }
      const slowPool = new Pool({
        connectionString: url.toString(),
        Client: DelayedDisconnectClient,
      });
      const closeSlowPool = trackPoolDisconnects(slowPool);
      t.after(closeSlowPool);
      let disconnected = 0;
      const clients = await Promise.all(Array.from({ length: 3 }, () => slowPool.connect()));
      const ended = clients.map(
        (client) =>
          new Promise((resolve) => {
            client.once('end', () => {
              disconnected++;
              resolve();
            });
          }),
      );
      const pids = [];
      try {
        for (const client of clients) {
          pids.push((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
          client.release();
        }
        const poolEnd = slowPool.end.bind(slowPool);
        slowPool.end = async () => {
          await poolEnd();
          t.diagnostic('pool.end resolved after ' + disconnected + '/3 client end events');
        };
        await closeSlowPool();
        assert.equal(disconnected, 3, 'cleanup must await every real client end event');
        assert.equal(
          (
            await admin.query(
              'SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid=ANY($1::int[])',
              [pids],
            )
          ).rows[0].n,
          0,
          'no backend from the closed pool may remain when DROP starts',
        );
      } finally {
        await closeSlowPool();
        await Promise.all(ended);
      }
    },
  );
});
