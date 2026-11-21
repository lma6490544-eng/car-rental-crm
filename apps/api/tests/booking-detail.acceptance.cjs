const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const { Pool } = require('pg');
const { drizzle } = require('drizzle-orm/node-postgres');
const { migrate } = require('drizzle-orm/node-postgres/migrator');
const { referenceDetail, detailPayload } = require('./helpers/booking-detail-reference.cjs');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env'), quiet: true });

test('Booking detail: compatible read model, one RR snapshot and no writes', async (t) => {
  const name = 'crm_detail_test_' + randomBytes(8).toString('hex');
  const url = new URL(process.env.DATABASE_URL);
  const admin = new Pool({ connectionString: url.toString() });
  let db;
  t.after(async () => {
    if (db) await db.pool.end();
    assert.match(name, /^crm_detail_test_[a-f0-9]{16}$/);
    await admin.query('DROP DATABASE IF EXISTS "' + name + '" WITH (FORCE)');
    await admin.end();
  });
  await admin.query('CREATE DATABASE "' + name + '"');
  url.pathname = '/' + name;
  process.env.DATABASE_URL = url.toString();
  const { DatabaseService } = require('../dist/database.service');
  const { SchedulingService } = require('../dist/scheduling/scheduling.service');
  const { SchedulingController } = require('../dist/scheduling/scheduling.controller');
  const { BookingQueryService } = require('../dist/scheduling/booking-query.service');
  db = new DatabaseService();
  await migrate(drizzle(db.pool), { migrationsFolder: path.resolve(__dirname, '../drizzle') });
  let trace = [];
  let evaluations = [];
  let afterQuery;
  let rrClient;
  const observedDb = Object.create(db);
  const observe = async (scope, query, args) => {
    trace.push({ scope, args: detailPayload(args) });
    const result = await query(...args);
    if (afterQuery) await afterQuery(scope, args[0]);
    return result;
  };
  Object.defineProperty(observedDb, 'pool', {
    value: {
      query: (...args) => observe('pool', db.pool.query.bind(db.pool), args),
      connect: async () => {
        const client = await db.pool.connect();
        const query = client.query;
        const release = client.release;
        rrClient = client;
        client.query = (...args) => observe('rr', query.bind(client), args);
        client.release = (...args) => {
          client.query = query;
          client.release = release;
          return release.apply(client, args);
        };
        return client;
      },
    },
  });
  const s = new SchedulingService(observedDb);
  const evaluate = s.evaluate.bind(s);
  s.evaluate = async (client, input, facts) => {
    assert.equal(client, rrClient);
    assert.equal(facts, undefined, 'single-card inspection does not use Calendar indices');
    const result = await evaluate(client, input, facts);
    evaluations.push({
      input: detailPayload(input),
      result: detailPayload({ availability: result }).availability,
    });
    return result;
  };
  const reference = referenceDetail(s);
  const controller = new SchedulingController(
    s,
    undefined,
    undefined,
    undefined,
    new BookingQueryService(observedDb, s),
  );
  const actor = (
    await db.pool.query(
      "INSERT INTO users(full_name,login,password_hash,role) VALUES ('Detail','detail','unused','manager') RETURNING id",
    )
  ).rows[0].id;
  const customers = [];
  for (const type of ['individual', 'company'])
    customers.push(
      (
        await db.pool.query(
          'INSERT INTO customers(type,display_name) VALUES ($1,$2) RETURNING id',
          [type, 'Detail ' + type],
        )
      ).rows[0].id,
    );
  const brand = (
    await db.pool.query("INSERT INTO vehicle_brands(name) VALUES ('Detail') RETURNING id")
  ).rows[0].id;
  const pricingGroup = (
    await db.pool.query("SELECT id FROM pricing_groups WHERE tariff_code='economy'")
  ).rows[0].id;
  const models = [];
  const cars = [];
  for (let i = 0; i < 3; i++) {
    models.push(
      (
        await db.pool.query(
          'INSERT INTO vehicle_models(brand_id,name,pricing_group_id) VALUES ($1,$2,$3) RETURNING id',
          [brand, 'Detail ' + i, pricingGroup],
        )
      ).rows[0].id,
    );
    cars.push(
      (
        await db.pool.query(
          "INSERT INTO vehicles(model_id,plate,year,body_type) VALUES ($1,$2,2020,'sedan') RETURNING id",
          [models[i], 'DETAIL' + i],
        )
      ).rows[0].id,
    );
  }
  cars.push(
    (
      await db.pool.query(
        "INSERT INTO vehicles(model_id,plate,year,body_type) VALUES ($1,'DETAIL3',2020,'sedan') RETURNING id",
        [models[0]],
      )
    ).rows[0].id,
  );
  const analogs = (
    await db.pool.query("INSERT INTO equivalence_groups(name) VALUES ('Detail') RETURNING id")
  ).rows[0].id;
  for (const model of models.slice(0, 2))
    await db.pool.query('INSERT INTO equivalence_group_models(group_id,model_id) VALUES ($1,$2)', [
      analogs,
      model,
    ]);
  const quote = (
    await db.pool.query(
      "INSERT INTO pricing_quotes(created_by,expires_at,input,snapshot) VALUES ($1,'2099-01-01','{}','{}') RETURNING id",
      [actor],
    )
  ).rows[0].id;
  const commercial = (price) => ({
    finalTotalRub: price,
    mileageLimitKm: 0,
    overrides: { customDailyRateRub: '0' },
    nonBillableDays: [{ dayIndex: 1, reason: 'Вых', markedAt: '2079-01-01T00:00:00Z' }],
  });
  const terms = async (bookingId, revision, price) =>
    (
      await db.pool.query(
        'INSERT INTO booking_terms(booking_id,revision,quote_id,snapshot,reason,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
        [
          bookingId,
          revision,
          quote,
          JSON.stringify(commercial(price)),
          'Редакция ' + revision,
          actor,
        ],
      )
    ).rows[0].id;
  const risk = async (bookingId, status) =>
    db.pool.query(
      'INSERT INTO booking_risks(booking_id,snapshot,reason,created_by) VALUES ($1,$2,$3,$4)',
      [
        bookingId,
        JSON.stringify({ status, token: 'a'.repeat(64), evaluatedAt: '2079-02-01T00:00:00Z' }),
        'Принят риск ' + status,
        actor,
      ],
    );
  const booking = async ({
    eligible = [models[0]],
    type = 'model',
    target = eligible[0],
    customer = customers[0],
    start = '2080-01-01',
    end = '2080-01-03',
  } = {}) => {
    const id = (
      await db.pool.query(
        'INSERT INTO bookings(customer_id,start_at,end_at,target_type,target_vehicle_id,target_model_id,target_group_id,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
        [
          customer,
          start,
          end,
          type,
          type === 'vehicle' ? target : null,
          type === 'model' ? target : null,
          type === 'equivalence_group' ? target : null,
          actor,
        ],
      )
    ).rows[0].id;
    for (const model of eligible)
      await db.pool.query(
        'INSERT INTO booking_eligible_models(booking_id,model_id) VALUES ($1,$2)',
        [id, model],
      );
    return id;
  };
  const block = async (car, start, end, bookingId = null) =>
    (
      await db.pool.query(
        'INSERT INTO schedule_blocks(vehicle_id,booking_id,kind,start_at,end_at,reason,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
        [car, bookingId, bookingId ? 'assignment' : 'technical', start, end, 'Detail block', actor],
      )
    ).rows[0].id;
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
  const outcome = async (owner, id) => {
    trace = [];
    evaluations = [];
    try {
      return { value: detailPayload(await owner.get(String(id))), trace, evaluations };
    } catch (error) {
      if (!error.getResponse) throw error;
      return {
        error: { status: error.getStatus(), body: error.getResponse() },
        trace,
        evaluations,
      };
    }
  };
  const compare = async (id, error) => {
    const before = await snapshot();
    const expected = await outcome(reference, id);
    const actual = await outcome(controller, id);
    assert.deepEqual(
      { value: actual.value, error: actual.error, evaluations: actual.evaluations },
      { value: expected.value, error: expected.error, evaluations: expected.evaluations },
      'full JSON, errors, both evaluations and exact HMAC',
    );
    const reads = (result) => result.trace.filter((x) => x.args[0].startsWith('SELECT'));
    assert.deepEqual(
      reads(actual).map((x) => x.args),
      reads(expected).map((x) => x.args),
      'read SQL order and parameters preserved',
    );
    assert.ok(
      actual.trace.every((x) => x.scope === 'rr'),
      'all queries use one client',
    );
    assert.equal(
      JSON.stringify(actual.value),
      JSON.stringify(expected.value),
      'serialization and array order',
    );
    if (error) {
      assert.equal(actual.error?.status, error[0]);
      assert.equal(actual.error?.body.code, error[1]);
      assert.equal(actual.trace.length, error[0] === 400 ? 0 : 5);
      if (error[0] === 404) assert.deepEqual(actual.trace.at(-1).args, ['ROLLBACK']);
    } else {
      assert.ok(actual.value);
      assert.equal(actual.evaluations.length, 2);
      assert.deepEqual(
        actual.trace.filter((x) => x.scope === 'pool'),
        [],
      );
      const rr = actual.trace.filter((x) => x.scope === 'rr');
      assert.deepEqual(
        rr.slice(0, 3).map((x) => x.args),
        [
          ['BEGIN'],
          ["SET LOCAL lock_timeout = '5s'"],
          ['SET TRANSACTION ISOLATION LEVEL REPEATABLE READ'],
        ],
      );
      assert.deepEqual(rr.at(-1).args, ['COMMIT']);
      assert.ok(
        actual.trace.findIndex((x) => x.args[0] === 'COMMIT') >
          actual.trace.findIndex((x) =>
            x.args[0].startsWith('SELECT v.id,v.model_id AS "modelId",m.pricing_group_id'),
          ),
      );
      for (const key of [
        'financialSummary',
        'paymentsAllowed',
        'debtRub',
        'allocations',
        'availableCreditRub',
        'customer',
      ])
        assert.equal(
          Object.hasOwn(actual.value, key),
          false,
          key + ' is not part of this endpoint',
        );
    }
    assert.deepEqual(
      await snapshot(),
      before,
      'all public tables unchanged including money/history/audit/keys',
    );
    return actual.value;
  };
  await t.test(
    'assigned, unassigned, cancelled, distinct customers and exact terms/risk history',
    async () => {
      const id = await booking();
      const assignment = await block(cars[0], '2080-01-01', '2080-01-03', id);
      await terms(id, 1, '9007199254740993');
      await terms(id, 2, '9223372036854775807');
      await risk(id, 'deficit');
      await risk(id, 'unknown');
      const assigned = await compare(id);
      assert.equal(assigned.customer_name, 'Detail individual');
      assert.equal(assigned.vehicle_id, cars[0]);
      assert.equal(assigned.vehicle.id, cars[0]);
      assert.equal(assigned.availability.status, 'feasible');
      assert.deepEqual(
        assigned.terms.map((x) => x.revision),
        [2, 1],
      );
      assert.deepEqual(
        assigned.terms.map((x) => x.snapshot.finalTotalRub),
        ['9223372036854775807', '9007199254740993'],
      );
      assert.deepEqual(
        assigned.risks.map((x) => x.snapshot.status),
        ['deficit', 'unknown'],
      );
      assert.equal(assigned.risks[0].snapshot.evaluatedAt, '2079-02-01T00:00:00Z');
      assert.equal(assigned.terms[0].snapshot.nonBillableDays[0].markedAt, '2079-01-01T00:00:00Z');
      assert.deepEqual(
        assigned.alternatives.map((x) => x.id),
        [cars[0], cars[3]],
      );
      assert.equal(assigned.vehicleOptions.length, 4, 'options include models outside saved pool');
      await db.pool.query(
        "UPDATE vehicles SET is_ready=false,readiness_reason='Ремонт' WHERE id=$1",
        [cars[0]],
      );
      const notReady = await compare(id);
      assert.equal(notReady.availability.status, 'deficit');
      assert.ok(notReady.problemReasons.some((x) => x.includes('не готов')));
      await db.pool.query("UPDATE vehicles SET is_ready=true,readiness_reason='' WHERE id=$1", [
        cars[0],
      ]);
      await db.pool.query('UPDATE schedule_blocks SET retired_at=now() WHERE id=$1', [assignment]);
      assert.equal((await compare(id)).vehicle_id, null);
      await db.pool.query("UPDATE bookings SET status='cancelled' WHERE id=$1", [id]);
      assert.equal((await compare(id)).status, 'cancelled');
      const other = await booking({
        customer: customers[1],
        eligible: [models[1]],
        start: '2081-01-01',
        end: '2081-01-03',
      });
      const empty = await compare(other);
      assert.equal(empty.customer_name, 'Detail company');
      assert.deepEqual(empty.terms, []);
      assert.deepEqual(empty.risks, []);
    },
  );
  await t.test(
    'saved analogs, technical conflicts, displacement reason and archive filtering',
    async () => {
      const id = await booking({
        eligible: [models[0]],
        type: 'equivalence_group',
        target: analogs,
        start: '2083-01-01',
        end: '2083-01-03',
      });
      assert.deepEqual(
        (await compare(id)).alternatives.map((x) => x.modelId),
        [models[0], models[0]],
      );
      const specific = await booking({
        eligible: [models[1]],
        type: 'vehicle',
        target: cars[1],
        start: '2083-02-01',
        end: '2083-02-03',
      });
      const blocked = await block(cars[1], '2083-02-02', '2083-02-03');
      const conflict = await compare(specific);
      assert.equal(conflict.availability.status, 'deficit');
      assert.deepEqual(
        conflict.conflicts.map((x) => x.id),
        [blocked],
      );
      await db.pool.query(
        "INSERT INTO audit_logs(actor_id,entity_type,action,entity_id,request_id,details) VALUES ($1,'booking','bookings.displaced',$2,$3,$4)",
        [
          actor,
          specific,
          '00000000-0000-4000-8000-000000000001',
          JSON.stringify({ previousVehicleId: cars[1], reason: 'Старый ремонт' }),
        ],
      );
      await db.pool.query(
        "INSERT INTO audit_logs(actor_id,entity_type,action,entity_id,request_id,details) VALUES ($1,'booking','bookings.displaced',$2,$3,$4)",
        [
          actor,
          specific,
          '00000000-0000-4000-8000-000000000002',
          JSON.stringify({ previousVehicleId: cars[1], reason: 'Последний ремонт' }),
        ],
      );
      await db.pool.query('DELETE FROM schedule_blocks WHERE id=$1', [blocked]);
      const displaced = await compare(specific);
      assert.equal(displaced.availability.status, 'feasible');
      assert.ok(displaced.replacementReason.endsWith('Последний ремонт'));
      assert.ok(displaced.problemReasons.includes('Требуется замена автомобиля'));
      await db.pool.query('UPDATE vehicles SET archived_at=now() WHERE id=$1', [cars[1]]);
      const archived = await compare(specific);
      assert.equal(archived.availability.status, 'deficit');
      assert.equal(
        archived.vehicleOptions.some((x) => x.id === cars[1]),
        false,
      );
      await db.pool.query('UPDATE vehicles SET archived_at=NULL WHERE id=$1', [cars[1]]);
    },
  );
  await t.test('connected model conflicts beyond card period and unknown limit', async () => {
    const root = await booking({ eligible: [models[1]], start: '2085-01-01', end: '2085-01-03' });
    const a = await booking({
      eligible: [models[1], models[2]],
      type: 'equivalence_group',
      target: analogs,
      start: '2085-01-02',
      end: '2085-01-05',
    });
    const b = await booking({ eligible: [models[2]], start: '2085-01-04', end: '2085-01-06' });
    const c = await booking({ eligible: [models[1]], start: '2085-01-04', end: '2085-01-06' });
    const deficit = await compare(root);
    assert.equal(deficit.availability.status, 'deficit');
    assert.deepEqual(deficit.availability.bookingIds, [root, a, b, c]);
    assert.ok(deficit.conflicts.some((x) => x.kind === 'unassigned' && x.booking_id === a));
    const chain = (
      await db.pool.query(
        "INSERT INTO bookings(customer_id,start_at,end_at,target_type,target_model_id,created_by) SELECT $1,'2086-01-01'::timestamptz+n*interval '1 day','2086-01-01'::timestamptz+(n+2)*interval '1 day','model',$2,$3 FROM generate_series(0,500) n RETURNING id",
        [customers[0], models[2], actor],
      )
    ).rows.map((x) => x.id);
    await db.pool.query(
      'INSERT INTO booking_eligible_models(booking_id,model_id) SELECT unnest($1::int[]),$2',
      [chain, models[2]],
    );
    const unknown = await compare(chain[0]);
    assert.equal(unknown.availability.status, 'unknown');
    assert.deepEqual(unknown.availability.bookingIds, chain);
  });
  await t.test('financial allocations are neither returned nor changed by this read', async () => {
    const id = await booking({ eligible: [models[2]], start: '2087-01-01', end: '2087-01-03' });
    const before = await compare(id);
    const operation = (
      await db.pool.query(
        "INSERT INTO financial_operations(command_id,request_hash,kind,customer_id,booking_id,actor_id,reason) VALUES ('historical-detail','fixture','rent_payment',$1,$2,$3,'Historical fixture') RETURNING id",
        [customers[0], id, actor],
      )
    ).rows[0].id;
    const lot = (
      await db.pool.query(
        "INSERT INTO finance_lots(customer_id,original_operation_id,origin,method) VALUES ($1,$2,'rent','cash') RETURNING id",
        [customers[0], operation],
      )
    ).rows[0].id;
    for (const [bucket, value] of [
      ['rent', '9007199254740993'],
      ['rent', '7'],
      ['deposit', '12000'],
      ['credit', '13'],
    ])
      await db.pool.query(
        'INSERT INTO finance_allocations(operation_id,lot_id,bucket,booking_id,amount_rub,fund) VALUES ($1,$2,$3,$4,$5,$6)',
        [operation, lot, bucket, bucket === 'credit' ? null : id, value, 'operating_cash'],
      );
    assert.deepEqual(
      await compare(id),
      before,
      'finance is a separate endpoint, no new summary or arithmetic',
    );
  });
  await t.test('invalid IDs and missing booking preserve exact errors', async () => {
    for (const id of ['invalid', '0', '-1', '1.5', '2147483648', ''])
      await compare(id, [400, 'VALIDATION_ERROR']);
    await compare(2147483647, [404, 'NOT_FOUND']);
  });
  await t.test(
    'concurrent commit after booking read leaves the whole card in its RR snapshot',
    async () => {
      const id = await booking({
        eligible: [models[2]],
        type: 'vehicle',
        target: cars[2],
        start: '2088-01-01',
        end: '2088-01-03',
      });
      const stable = await compare(id);
      for (const owner of [controller]) {
        const before = await snapshot();
        let inserted;
        afterQuery = async (scope, sql) => {
          if (scope !== 'rr' || !sql.startsWith('SELECT b.*,c.display_name')) return;
          afterQuery = undefined;
          inserted = await block(cars[2], '2088-01-01', '2088-01-02');
          await terms(id, 1, '12345');
          await risk(id, 'deficit');
        };
        try {
          const mixed = await outcome(owner, id);
          assert.ok(inserted);
          assert.deepEqual(
            mixed.value.availability,
            stable.availability,
            'old RR facts and exact token',
          );
          assert.deepEqual(mixed.value.alternatives, stable.alternatives);
          assert.equal(
            mixed.value.vehicleOptions.find((x) => x.id === cars[2]).busy,
            false,
            'options retain the same snapshot as inspection',
          );
          assert.deepEqual(mixed.value, stable, 'whole response retains the original snapshot');
          assert.ok(mixed.trace.every((x) => x.scope === 'rr'));
          const next = (await outcome(owner, id)).value;
          assert.equal(next.availability.status, 'deficit');
          assert.equal(next.vehicleOptions.find((x) => x.id === cars[2]).busy, true);
          assert.equal(next.terms[0].snapshot.finalTotalRub, '12345');
          assert.equal(next.risks[0].snapshot.status, 'deficit');
        } finally {
          afterQuery = undefined;
          if (inserted) await db.pool.query('DELETE FROM schedule_blocks WHERE id=$1', [inserted]);
          await db.pool.query('DELETE FROM booking_terms WHERE booking_id=$1', [id]);
          await db.pool.query('DELETE FROM booking_risks WHERE booking_id=$1', [id]);
        }
        assert.deepEqual(await snapshot(), before, 'only explicit test writer changed rows');
      }
    },
  );
});
