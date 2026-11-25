const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const { Pool } = require('pg');
const { drizzle } = require('drizzle-orm/node-postgres');
const { migrate } = require('drizzle-orm/node-postgres/migrator');
const { referenceEvaluation, evaluationPayload } = require('./helpers/evaluate-reference.cjs');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env'), quiet: true });

test('Availability endpoint: frozen orchestration, one solver pass and RR', async (t) => {
  const name = 'crm_evaluate_test_' + randomBytes(8).toString('hex');
  const url = new URL(process.env.DATABASE_URL);
  const admin = new Pool({ connectionString: url.toString() });
  let db;
  t.after(async () => {
    if (db) await db.pool.end();
    assert.match(name, /^crm_evaluate_test_[a-f0-9]{16}$/);
    await admin.query('DROP DATABASE IF EXISTS "' + name + '" WITH (FORCE)');
    await admin.end();
  });
  await admin.query('CREATE DATABASE "' + name + '"');
  url.pathname = '/' + name;
  process.env.DATABASE_URL = url.toString();
  const { DatabaseService } = require('../dist/database.service');
  // Observe the real solver, preserving its demands, order, budget and output.
  const algorithm = require('../dist/scheduling/availability');
  const solve = algorithm.evaluateAvailability;
  let solvers = [];
  algorithm.evaluateAvailability = (...args) => {
    const result = solve(...args);
    solvers.push(evaluationPayload({ args, result }));
    return result;
  };
  t.after(() => {
    algorithm.evaluateAvailability = solve;
  });
  const { SchedulingService } = require('../dist/scheduling/scheduling.service');
  const { SchedulingController } = require('../dist/scheduling/scheduling.controller');
  db = new DatabaseService();
  await migrate(drizzle(db.pool), { migrationsFolder: path.resolve(__dirname, '../drizzle') });
  let trace = [];
  let transactions = 0;
  let evaluations = [];
  let activeClient;
  let afterQuery;
  // Inherit the unchanged real transaction implementation. Observe the client's
  // SQL from BEGIN to release, while fixture/concurrent writes use the real pool.
  const observedDb = Object.create(db);
  Object.defineProperty(observedDb, 'pool', {
    value: {
      connect: async () => {
        const client = await db.pool.connect();
        const query = client.query;
        const release = client.release;
        activeClient = client;
        client.query = async (...args) => {
          trace.push(evaluationPayload(args));
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
  const s = new SchedulingService({
    pool: db.pool,
    transaction: (work) => {
      transactions++;
      return observedDb.transaction(work);
    },
  });
  const evaluate = s.evaluate.bind(s);
  s.evaluate = async (client, input, facts) => {
    assert.equal(client, activeClient, 'one transaction client');
    assert.equal(
      facts?.preparation,
      undefined,
      'no Calendar request indices for a single evaluate',
    );
    const result = await evaluate(client, input, facts);
    evaluations.push(evaluationPayload({ input, result }));
    return result;
  };
  const controller = new SchedulingController(s);
  const reference = referenceEvaluation(s);
  const actor = (
    await db.pool.query(
      "INSERT INTO users(full_name,login,password_hash,role) VALUES ('Evaluate','evaluate','unused','manager') RETURNING id",
    )
  ).rows[0].id;
  const brand = (
    await db.pool.query("INSERT INTO vehicle_brands(name) VALUES ('Evaluate') RETURNING id")
  ).rows[0].id;
  const customer = (
    await db.pool.query(
      "INSERT INTO customers(type,display_name) VALUES ('individual','Evaluate') RETURNING id",
    )
  ).rows[0].id;
  const group = (await db.pool.query("SELECT id FROM pricing_groups WHERE tariff_code='economy'"))
    .rows[0].id;
  const models = [];
  const cars = [];
  for (let i = 0; i < 3; i++) {
    models.push(
      (
        await db.pool.query(
          'INSERT INTO vehicle_models(brand_id,name,pricing_group_id) VALUES ($1,$2,$3) RETURNING id',
          [brand, 'Evaluate ' + i, group],
        )
      ).rows[0].id,
    );
    cars.push(
      (
        await db.pool.query(
          "INSERT INTO vehicles(model_id,plate,year,body_type) VALUES ($1,$2,2020,'sedan') RETURNING id",
          [models[i], 'EVAL' + i],
        )
      ).rows[0].id,
    );
  }
  const analogs = (
    await db.pool.query("INSERT INTO equivalence_groups(name) VALUES ('Evaluate') RETURNING id")
  ).rows[0].id;
  for (const model of models.slice(0, 2))
    await db.pool.query('INSERT INTO equivalence_group_models(group_id,model_id) VALUES ($1,$2)', [
      analogs,
      model,
    ]);
  const input = (type = 'vehicle', id = cars[0], changes = {}) => ({
    target: { type, id },
    startAt: '2080-01-01T00:00:00Z',
    endAt: '2080-01-03T00:00:00Z',
    ...changes,
  });
  const tables = (
    await db.pool.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
    )
  ).rows.map((row) => row.tablename);
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
    transactions = 0;
    evaluations = [];
    solvers = [];
    try {
      const value = evaluationPayload(await owner.evaluate(body));
      return { value, trace, transactions, evaluations, solvers };
    } catch (error) {
      if (!error.getResponse) throw error;
      return {
        error: { status: error.getStatus(), body: error.getResponse() },
        trace,
        transactions,
        evaluations,
        solvers,
      };
    }
  };
  const compare = async (body, error) => {
    const before = await snapshot();
    const expected = await outcome(reference, body);
    const actual = await outcome(controller, body);
    assert.deepEqual(
      actual,
      expected,
      'complete JSON, SQL/parameters, inputs and solver outputs, exact HMAC',
    );
    if (error) {
      assert.equal(actual.error?.status, error[0]);
      assert.equal(actual.error?.body.code, error[1]);
      if (error[0] === 400) assert.equal(actual.transactions, 0);
      else assert.deepEqual(actual.trace.at(-1), ['ROLLBACK']);
    } else {
      assert.ok(actual.value, JSON.stringify(actual.error));
      assert.equal(actual.transactions, 1);
      assert.deepEqual(actual.trace.slice(0, 3), [
        ['BEGIN'],
        ["SET LOCAL lock_timeout = '5s'"],
        ['SET TRANSACTION ISOLATION LEVEL REPEATABLE READ'],
      ]);
      assert.deepEqual(actual.trace.at(-1), ['COMMIT']);
      assert.equal(actual.evaluations.length, 1);
      assert.equal(actual.solvers.length, 1);
      assert.equal(
        actual.trace.filter(([sql]) => sql.startsWith('SELECT id,model_id,is_ready,version'))
          .length,
        1,
      );
      assert.match(actual.value.token, /^[a-f0-9]{64}$/);
    }
    assert.deepEqual(await snapshot(), before, 'all public tables unchanged, including errors');
    return actual.value;
  };
  const booking = async (start, end, eligible, type = 'model', targetId = eligible[0]) => {
    const row = (
      await db.pool.query(
        'INSERT INTO bookings(customer_id,start_at,end_at,target_type,target_model_id,target_group_id,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
        [
          customer,
          start,
          end,
          type,
          type === 'model' ? targetId : null,
          type === 'equivalence_group' ? targetId : null,
          actor,
        ],
      )
    ).rows[0];
    for (const model of eligible)
      await db.pool.query(
        'INSERT INTO booking_eligible_models(booking_id,model_id) VALUES ($1,$2)',
        [row.id, model],
      );
    return row;
  };
  const block = async (start, end, bookingId = null, vehicle = cars[0]) =>
    (
      await db.pool.query(
        'INSERT INTO schedule_blocks(vehicle_id,booking_id,kind,start_at,end_at,reason,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
        [
          vehicle,
          bookingId,
          bookingId ? 'assignment' : 'technical',
          start,
          end,
          'Evaluate test',
          actor,
        ],
      )
    ).rows[0].id;

  await t.test(
    'new targets, saved models, target change, assignment exclusion and cancelled booking contract',
    async () => {
      for (const [type, id] of [
        ['vehicle', cars[0]],
        ['model', models[0]],
        ['brand', brand],
        ['equivalence_group', analogs],
      ])
        assert.equal((await compare(input(type, id))).status, 'feasible');
      const old = await booking(
        '2080-01-01T00:00:00Z',
        '2080-01-03T00:00:00Z',
        [models[0]],
        'equivalence_group',
        analogs,
      );
      const assignment = await block('2080-01-01T00:00:00Z', '2080-01-03T00:00:00Z', old.id);
      const saved = await compare(
        input('equivalence_group', analogs, { bookingId: old.id, vehicleId: cars[0] }),
      );
      assert.equal(saved.status, 'feasible');
      assert.deepEqual(saved.conflicts, []);
      assert.deepEqual(
        saved.alternatives.map((v) => v.modelId),
        [models[0]],
      );
      const changed = await compare(input('model', models[1], { bookingId: old.id }));
      assert.deepEqual(
        changed.alternatives.map((v) => v.modelId),
        [models[1]],
      );
      // Explicit vehicle target overrides a different vehicleId; broad target keeps it.
      assert.equal(
        (await compare(input('vehicle', cars[0], { bookingId: old.id, vehicleId: cars[1] })))
          .vehicle.id,
        cars[0],
      );
      assert.equal(
        (await compare(input('model', models[0], { bookingId: old.id, vehicleId: cars[1] })))
          .status,
        'deficit',
      );
      await compare(input('model', models[0], { bookingId: 2147483647 }), [404, 'NOT_FOUND']);
      await db.pool.query('DELETE FROM schedule_blocks WHERE id=$1', [assignment]);
      await db.pool.query("UPDATE bookings SET status='cancelled' WHERE id=$1", [old.id]);
      assert.equal(
        (await compare(input('equivalence_group', analogs, { bookingId: old.id }))).status,
        'feasible',
      );
      await compare(input('vehicle', 2147483647), [422, 'EMPTY_TARGET']);
    },
  );
  await t.test('strict DTO and exact validation errors before any transaction', async () => {
    for (const body of [
      null,
      {},
      { ...input(), extra: true },
      input('vehicle', -1),
      input('vehicle', cars[0], { bookingId: '1' }),
      input('vehicle', cars[0], { expectedVersion: 1 }),
      input('vehicle', cars[0], { vehicleId: 0 }),
      input('vehicle', cars[0], { startAt: 'invalid' }),
      input('vehicle', cars[0], { startAt: '2080-01-01T00:00:00' }),
      input('vehicle', cars[0], { endAt: '2080-01-01T00:00:00Z' }),
    ])
      await compare(body, [400, 'VALIDATION_ERROR']);
  });
  await t.test('archive, readiness, technical blocks and half-open intervals', async () => {
    await db.pool.query('UPDATE vehicles SET archived_at=now() WHERE id=$1', [cars[0]]);
    await compare(input(), [422, 'EMPTY_TARGET']);
    assert.equal((await compare(input('model', models[0]))).status, 'deficit');
    await db.pool.query(
      "UPDATE vehicles SET archived_at=NULL,is_ready=false,readiness_reason='Ремонт' WHERE id=$1",
      [cars[0]],
    );
    const notReady = await compare(input());
    assert.equal(notReady.status, 'deficit');
    assert.ok(notReady.problemReasons.some((reason) => reason.includes('не готов')));
    await db.pool.query("UPDATE vehicles SET is_ready=true,readiness_reason='' WHERE id=$1", [
      cars[0],
    ]);
    const adjacent = await block('2080-01-03T00:00:00Z', '2080-01-04T00:00:00Z');
    assert.equal((await compare(input())).status, 'feasible');
    const inside = await block('2080-01-02T23:00:00Z', '2080-01-03T00:00:00Z');
    const blocked = await compare(input());
    assert.equal(blocked.status, 'deficit');
    assert.deepEqual(
      blocked.conflicts.map((x) => x.id),
      [inside],
    );
    await db.pool.query('DELETE FROM schedule_blocks WHERE id=ANY($1::int[])', [
      [adjacent, inside],
    ]);
  });
  await t.test(
    'assigned/unassigned demands, intersecting pools outside window, empty candidates and unknown',
    async () => {
      const a = await booking(
        '2080-01-02T00:00:00Z',
        '2080-01-05T00:00:00Z',
        models.slice(0, 2),
        'equivalence_group',
        analogs,
      );
      const b = await booking('2080-01-04T00:00:00Z', '2080-01-06T00:00:00Z', [models[1]]);
      const c = await booking('2080-01-04T00:00:00Z', '2080-01-06T00:00:00Z', [models[0]]);
      const assignment = await block('2080-01-04T00:00:00Z', '2080-01-06T00:00:00Z', b.id, cars[1]);
      const deficit = await compare(input('model', models[0]));
      assert.equal(deficit.status, 'deficit');
      assert.deepEqual(deficit.bookingIds, [0, a.id, b.id, c.id]);
      assert.ok(deficit.conflicts.some((x) => x.kind === 'unassigned' && x.booking_id === a.id));
      await db.pool.query(
        "UPDATE vehicles SET is_ready=false,readiness_reason='Ремонт' WHERE id=$1",
        [cars[1]],
      );
      assert.deepEqual((await compare(input('model', models[0]))).bookingIds, deficit.bookingIds);
      await db.pool.query("UPDATE vehicles SET is_ready=true,readiness_reason='' WHERE id=$1", [
        cars[1],
      ]);
      await db.pool.query('DELETE FROM schedule_blocks WHERE id=$1', [assignment]);
      await db.pool.query("UPDATE bookings SET status='cancelled' WHERE id=ANY($1::int[])", [
        [a.id, b.id, c.id],
      ]);
      const chain = (
        await db.pool.query(
          "INSERT INTO bookings(customer_id,start_at,end_at,target_type,target_model_id,created_by) SELECT $1,'2082-01-01T00:00:00Z'::timestamptz+n*interval '1 day','2082-01-01T00:00:00Z'::timestamptz+(n+2)*interval '1 day','model',$2,$3 FROM generate_series(1,501) n RETURNING id",
          [customer, models[0], actor],
        )
      ).rows.map((row) => row.id);
      await db.pool.query(
        'INSERT INTO booking_eligible_models(booking_id,model_id) SELECT unnest($1::int[]),$2',
        [chain, models[0]],
      );
      const unknown = await compare(
        input('model', models[0], {
          startAt: '2082-01-01T00:00:00Z',
          endAt: '2082-01-03T00:00:00Z',
        }),
      );
      assert.equal(unknown.status, 'unknown');
      assert.deepEqual(unknown.bookingIds, [0, ...chain]);
      assert.ok(unknown.problemReasons.includes('Доступность не подтверждена'));
    },
  );
  await t.test(
    'concurrent commit while loading alternative labels remains outside the RR snapshot',
    async () => {
      const body = input('vehicle', cars[0], {
        startAt: '2084-01-01T00:00:00Z',
        endAt: '2084-01-03T00:00:00Z',
      });
      const stable = await compare(body);
      const stableDetails = await outcome(reference, body);
      for (const owner of [reference, controller]) {
        const before = await snapshot();
        let inserted;
        afterQuery = async (sql) => {
          if (!sql.startsWith('SELECT v.id,v.model_id AS')) return;
          afterQuery = undefined;
          inserted = await block('2084-01-01T00:00:00Z', '2084-01-02T00:00:00Z');
        };
        try {
          const concurrent = await outcome(owner, body);
          assert.ok(inserted);
          assert.deepEqual(
            concurrent.value,
            stable,
            'both contexts and exact token use pre-commit facts',
          );
          assert.deepEqual(concurrent.evaluations, stableDetails.evaluations);
          assert.deepEqual(concurrent.solvers, stableDetails.solvers);
          const fresh = await outcome(owner, body);
          assert.equal(fresh.value.status, 'deficit');
          assert.notEqual(fresh.value.token, stable.token);
          assert.deepEqual(fresh.value.alternatives, []);
          assert.deepEqual(
            concurrent.value.alternatives.map((v) => v.id),
            [cars[0]],
          );
        } finally {
          afterQuery = undefined;
          if (inserted) await db.pool.query('DELETE FROM schedule_blocks WHERE id=$1', [inserted]);
        }
        assert.deepEqual(await snapshot(), before, 'only the explicit test writer inserted a row');
      }
    },
  );
});
