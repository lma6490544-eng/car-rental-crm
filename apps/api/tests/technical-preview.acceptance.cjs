const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const { Pool } = require('pg');
const { drizzle } = require('drizzle-orm/node-postgres');
const { migrate } = require('drizzle-orm/node-postgres/migrator');
const referencePreview = require('./helpers/technical-preview-reference.cjs');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env'), quiet: true });

test('Technical preview: frozen JSON/HMAC, SQL, RR snapshot and no writes', async (t) => {
  const name = 'crm_technical_preview_test_' + randomBytes(8).toString('hex');
  const url = new URL(process.env.DATABASE_URL);
  const admin = new Pool({ connectionString: url.toString() });
  let db;
  t.after(async () => {
    if (db) await db.pool.end();
    assert.match(name, /^crm_technical_preview_test_[a-f0-9]{16}$/);
    await admin.query('DROP DATABASE IF EXISTS "' + name + '" WITH (FORCE)');
    await admin.end();
  });
  await admin.query('CREATE DATABASE "' + name + '"');
  url.pathname = '/' + name;
  process.env.DATABASE_URL = url.toString();
  const { DatabaseService } = require('../dist/database.service');
  const { SchedulingService } = require('../dist/scheduling/scheduling.service');
  const { SchedulingController } = require('../dist/scheduling/scheduling.controller');
  const { TechnicalBlockService } = require('../dist/scheduling/technical-block.service');
  db = new DatabaseService();
  await migrate(drizzle(db.pool), { migrationsFolder: path.resolve(__dirname, '../drizzle') });
  let trace = [];
  let afterQuery;
  let connects = 0;
  const observed = Object.create(db);
  Object.defineProperty(observed, 'pool', {
    value: {
      connect: async () => {
        connects++;
        const client = await db.pool.connect();
        const query = client.query;
        const release = client.release;
        client.query = async (...args) => {
          trace.push(JSON.parse(JSON.stringify(args)));
          const result = await query.apply(client, args);
          if (afterQuery) await afterQuery(args[0]);
          return result;
        };
        client.release = (...args) => {
          client.query = query;
          client.release = release;
          return release.apply(client, args);
        };
        return client;
      },
    },
  });
  const s = new SchedulingService(observed, {
    run: () => assert.fail('read preview must not invoke CommandsService'),
  });
  const reference = referencePreview(s);
  const controller = new SchedulingController(
    s,
    undefined,
    undefined,
    new TechnicalBlockService(s),
  );
  const actor = (
    await db.pool.query(
      "INSERT INTO users(full_name,login,password_hash,role) VALUES ('Preview','preview','unused','manager') RETURNING id",
    )
  ).rows[0].id;
  const customer = (
    await db.pool.query(
      "INSERT INTO customers(type,display_name) VALUES ('individual','Preview customer') RETURNING id",
    )
  ).rows[0].id;
  const brand = (
    await db.pool.query("INSERT INTO vehicle_brands(name) VALUES ('Preview') RETURNING id")
  ).rows[0].id;
  const group = (await db.pool.query("SELECT id FROM pricing_groups WHERE tariff_code='economy'"))
    .rows[0].id;
  const model = (
    await db.pool.query(
      "INSERT INTO vehicle_models(brand_id,name,pricing_group_id) VALUES ($1,'Preview',$2) RETURNING id",
      [brand, group],
    )
  ).rows[0].id;
  const car = (
    await db.pool.query(
      "INSERT INTO vehicles(model_id,plate,year,body_type) VALUES ($1,'PREVIEW',2020,'sedan') RETURNING id",
      [model],
    )
  ).rows[0].id;
  const at = (day) => `2080-01-${String(day).padStart(2, '0')}T00:00:00Z`;
  const input = (start, end, extra = {}) => ({
    vehicleId: car,
    startAt: at(start),
    endAt: at(end),
    ...extra,
  });
  const booking = async (start, end) =>
    (
      await db.pool.query(
        "INSERT INTO bookings(customer_id,start_at,end_at,target_type,target_model_id,created_by) VALUES ($1,$2,$3,'model',$4,$5) RETURNING id",
        [customer, at(start), at(end), model, actor],
      )
    ).rows[0].id;
  const block = async (start, end, bookingId = null) =>
    (
      await db.pool.query(
        'INSERT INTO schedule_blocks(vehicle_id,booking_id,kind,start_at,end_at,reason,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
        [
          car,
          bookingId,
          bookingId ? 'assignment' : 'technical',
          at(start),
          at(end),
          'Причина ' + start,
          actor,
        ],
      )
    ).rows[0].id;
  const firstBooking = await booking(2, 4);
  const secondBooking = await booking(6, 8);
  // Deliberately insert out of chronological order to protect SQL ordering.
  const second = await block(6, 8, secondBooking);
  const technical = await block(4, 6);
  const first = await block(2, 4, firstBooking);
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
  const outcome = async (owner, body) => {
    trace = [];
    connects = 0;
    let result;
    try {
      result = { value: JSON.parse(JSON.stringify(await owner.previewTechnical(body))) };
    } catch (error) {
      if (!error.getResponse) throw error;
      result = { error: { status: error.getStatus(), body: error.getResponse() } };
    }
    return { ...result, trace, connects };
  };
  const compare = async (body, ids, error) => {
    const before = await snapshot();
    const expected = await outcome(reference, body);
    const actual = await outcome(controller, body);
    assert.deepEqual(
      actual,
      expected,
      'full JSON, exact HMAC, SQL order/parameters and connection count',
    );
    assert.equal(JSON.stringify(actual), JSON.stringify(expected));
    assert.deepEqual(await snapshot(), before, 'all public tables unchanged without normalization');
    if (error) {
      assert.equal(actual.error.status, error[0]);
      assert.equal(actual.error.body.code, error[1]);
    } else {
      assert.deepEqual(
        actual.value.conflicts.map((x) => x.id),
        ids,
      );
      assert.match(actual.value.token, /^[a-f0-9]{64}$/);
      assert.equal(actual.connects, 1);
      assert.deepEqual(actual.trace.slice(0, 3), [
        ['BEGIN'],
        ["SET LOCAL lock_timeout = '5s'"],
        ['SET TRANSACTION ISOLATION LEVEL REPEATABLE READ'],
      ]);
      assert.deepEqual(actual.trace.at(-1), ['COMMIT']);
      assert.equal(actual.trace.length, 6);
      assert.ok(
        actual.trace.every(([sql]) => !/FOR UPDATE|advisory|INSERT|UPDATE|DELETE/i.test(sql)),
      );
    }
    return actual.value;
  };
  await t.test(
    'empty, one and complete chronological conflicts including exact reasons/versions/overlaps',
    async () => {
      await compare(input(10, 11), []);
      const one = await compare(input(2, 3), [first]);
      assert.deepEqual(one.conflicts[0], {
        id: first,
        vehicle_id: car,
        booking_id: firstBooking,
        kind: 'assignment',
        start_at: new Date(at(2)).toISOString(),
        end_at: new Date(at(4)).toISOString(),
        reason: 'Причина 2',
        version: 1,
        booking_version: 1,
        customer_name: 'Preview customer',
        overlap_start: new Date(at(2)).toISOString(),
        overlap_end: new Date(at(3)).toISOString(),
      });
      const all = await compare(input(1, 9), [first, technical, second]);
      assert.deepEqual(
        all.conflicts.map((x) => x.booking_version),
        [1, null, 1],
      );
      assert.equal(all.conflicts[1].reason, 'Причина 4');
    },
  );
  await t.test(
    'editing excludes self; missing, stale/retired and assignment block IDs retain existing read contract',
    async () => {
      await compare(input(4, 6, { blockId: technical }), []);
      await compare(input(1, 9, { blockId: technical }), [first, second]);
      await compare(input(4, 6, { blockId: 2147483647 }), [technical]);
      await compare(input(2, 4, { blockId: first }), []);
      await db.pool.query('UPDATE schedule_blocks SET version=version+1 WHERE id=$1', [technical]);
      await compare(input(4, 6, { blockId: technical }), []);
      await db.pool.query(
        'UPDATE schedule_blocks SET retired_at=now(),version=version+1 WHERE id=$1',
        [technical],
      );
      await compare(input(4, 6, { blockId: technical }), []);
      await db.pool.query('UPDATE schedule_blocks SET retired_at=NULL WHERE id=$1', [technical]);
    },
  );
  await t.test('half-open touching boundaries and technical intersections', async () => {
    await compare(input(1, 2), []);
    await compare(input(4, 6), [technical]);
    await compare(input(8, 9), []);
  });
  await t.test(
    'booking and vehicle versions affect exact token; readiness is not a preview prohibition',
    async () => {
      const before = await compare(input(2, 4), [first]);
      await db.pool.query('UPDATE bookings SET version=version+1 WHERE id=$1', [firstBooking]);
      const after = await compare(input(2, 4), [first]);
      assert.equal(after.conflicts[0].booking_version, 2);
      assert.notEqual(after.token, before.token);
      await db.pool.query(
        "UPDATE vehicles SET is_ready=false,readiness_reason='Ремонт',version=version+1 WHERE id=$1",
        [car],
      );
      const unready = await compare(input(2, 4), [first]);
      assert.notEqual(unready.token, after.token);
    },
  );
  await t.test(
    'DTO errors precede connections; missing/archived vehicle rolls back with exact errors',
    async () => {
      for (const body of [
        input(4, 4),
        input(6, 4),
        input(1, 2, { extra: true }),
        input(1, 2, { blockId: 0 }),
        input(1, 2, { startAt: 'invalid' }),
      ]) {
        await compare(body, undefined, [400, 'VALIDATION_ERROR']);
        assert.equal(connects, 0);
      }
      await compare(input(1, 2, { vehicleId: 2147483647 }), undefined, [404, 'NOT_FOUND']);
      assert.deepEqual(trace.at(-1), ['ROLLBACK']);
      await db.pool.query('UPDATE vehicles SET archived_at=now() WHERE id=$1', [car]);
      await compare(input(1, 2), undefined, [404, 'NOT_FOUND']);
      await db.pool.query('UPDATE vehicles SET archived_at=NULL WHERE id=$1', [car]);
    },
  );
  await t.test(
    'concurrent commit after vehicle read retains RR conflicts and token; next preview sees new version',
    async () => {
      const body = input(1, 9);
      const baseline = await outcome(reference, body);
      const before = await snapshot();
      const version = (
        await db.pool.query('SELECT version FROM bookings WHERE id=$1', [secondBooking])
      ).rows[0].version;
      for (const owner of [reference, controller]) {
        let committed = false;
        afterQuery = async (sql) => {
          if (!sql.startsWith('SELECT id,version,archived_at')) return;
          assert.equal(committed, false);
          committed = true;
          await db.transaction(async (writer) => {
            await writer.query('UPDATE bookings SET version=version+1 WHERE id=$1', [
              secondBooking,
            ]);
          });
        };
        let current;
        try {
          current = await outcome(owner, body);
        } finally {
          afterQuery = undefined;
        }
        assert.equal(committed, true);
        assert.deepEqual(current, baseline);
        const next = await outcome(owner, body);
        assert.equal(next.value.conflicts.at(-1).booking_version, version + 1);
        assert.notEqual(next.value.token, baseline.value.token);
        await db.pool.query('UPDATE bookings SET version=$2 WHERE id=$1', [secondBooking, version]);
        assert.deepEqual(await snapshot(), before, 'only explicit test writer changed data');
      }
    },
  );
});
