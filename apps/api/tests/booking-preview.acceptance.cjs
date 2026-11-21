const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const { Pool } = require('pg');
const { drizzle } = require('drizzle-orm/node-postgres');
const { migrate } = require('drizzle-orm/node-postgres/migrator');
const { referencePreview, previewPayload } = require('./helpers/preview-reference.cjs');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env'), quiet: true });

test(
  'Booking preview: frozen orchestration, no writes and concurrent read snapshot',
  { timeout: 120000 },
  async (t) => {
    const name = 'crm_preview_test_' + randomBytes(8).toString('hex');
    const url = new URL(process.env.DATABASE_URL);
    const admin = new Pool({ connectionString: url.toString() });
    let db;
    t.after(async () => {
      if (db) await db.pool.end();
      assert.match(name, /^crm_preview_test_[a-f0-9]{16}$/);
      await admin.query('DROP DATABASE IF EXISTS "' + name + '" WITH (FORCE)');
      await admin.end();
    });
    await admin.query('CREATE DATABASE "' + name + '"');
    url.pathname = '/' + name;
    process.env.DATABASE_URL = url.toString();
    const { DatabaseService } = require('../dist/database.service');
    const { SchedulingService } = require('../dist/scheduling/scheduling.service');
    const { SchedulingController } = require('../dist/scheduling/scheduling.controller');
    const { BookingService } = require('../dist/scheduling/booking.service');
    db = new DatabaseService();
    await migrate(drizzle(db.pool), { migrationsFolder: path.resolve(__dirname, '../drizzle') });

    // Only observe/coordinate real SQL. No Pricing, Scheduling, solver or transaction mocks.
    let trace = [];
    let transactions = 0;
    let afterQuery;
    const observedDb = {
      pool: db.pool,
      transaction: (work) => {
        transactions++;
        return db.transaction((client) =>
          work({
            query: async (...args) => {
              trace.push(JSON.parse(JSON.stringify(args)));
              const result = await client.query(...args);
              if (afterQuery) await afterQuery(args[0]);
              return result;
            },
          }),
        );
      },
    };
    const s = new SchedulingService(observedDb);
    const controller = new SchedulingController(s, new BookingService(s));
    const reference = referencePreview(s);
    const actor = (
      await db.pool.query(
        "INSERT INTO users(full_name,login,password_hash,role) VALUES ('Preview','preview','unused','manager') RETURNING id",
      )
    ).rows[0].id;
    const request = { auth: { user: { id: actor } } };
    const group = (await db.pool.query("SELECT id FROM pricing_groups WHERE tariff_code='economy'"))
      .rows[0].id;
    const brand = (
      await db.pool.query("INSERT INTO vehicle_brands(name) VALUES ('Preview') RETURNING id")
    ).rows[0].id;
    const customer = (
      await db.pool.query(
        "INSERT INTO customers(type,display_name) VALUES ('individual','Preview') RETURNING id",
      )
    ).rows[0].id;
    const models = [];
    const cars = [];
    for (let i = 0; i < 3; i++) {
      models.push(
        (
          await db.pool.query(
            'INSERT INTO vehicle_models(brand_id,name,pricing_group_id) VALUES ($1,$2,$3) RETURNING id',
            [brand, 'Preview ' + i, group],
          )
        ).rows[0].id,
      );
      cars.push(
        (
          await db.pool.query(
            "INSERT INTO vehicles(model_id,plate,year,body_type) VALUES ($1,$2,2020,'sedan') RETURNING id",
            [models[i], 'PREVIEW' + i],
          )
        ).rows[0].id,
      );
    }
    const analogs = (
      await db.pool.query("INSERT INTO equivalence_groups(name) VALUES ('Preview') RETURNING id")
    ).rows[0].id;
    for (const model of models.slice(0, 2))
      await db.pool.query(
        'INSERT INTO equivalence_group_models(group_id,model_id) VALUES ($1,$2)',
        [analogs, model],
      );
    const pricing = {
      startAt: '2080-01-01T00:00:00Z',
      contractDays: 2,
      dailyMileagePackageKm: 250,
    };
    const input = (type = 'vehicle', id = cars[0], changes = {}) => ({
      target: { type, id },
      pricing,
      ...changes,
    });
    const publicTables = (
      await db.pool.query(
        "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
      )
    ).rows.map((row) => row.tablename);
    const snapshot = async () => {
      const rows = {};
      for (const table of publicTables) {
        assert.match(table, /^[a-z_][a-z0-9_]*$/);
        rows[table] = (
          await db.pool.query(
            "SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t::text),'[]'::jsonb) AS rows FROM \"" +
              table +
              '" t',
          )
        ).rows[0].rows;
      }
      return rows;
    };
    const outcome = async (owner, body) => {
      trace = [];
      transactions = 0;
      try {
        return { value: previewPayload(await owner.preview(body, request)), trace, transactions };
      } catch (error) {
        if (!error.getResponse) throw error;
        return {
          error: { status: error.getStatus(), body: error.getResponse() },
          trace,
          transactions,
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
        'entire JSON, ordered arrays, exact tokens and SQL order/parameters',
      );
      if (error) {
        assert.equal(actual.error?.status, error[0]);
        assert.equal(actual.error?.body.code, error[1]);
      } else {
        assert.ok(actual.value, JSON.stringify(actual.error));
        assert.equal(actual.transactions, 1);
        assert.deepEqual(actual.trace[0], ['SET TRANSACTION ISOLATION LEVEL REPEATABLE READ']);
        assert.equal(
          actual.trace.filter(([sql]) => sql.startsWith('SELECT id,model_id,is_ready,version'))
            .length,
          2,
          'both availability contexts remain',
        );
      }
      assert.deepEqual(
        await snapshot(),
        before,
        'all public tables stay identical, including customers, quotes, finance, audit/outbox and keys',
      );
      return actual.value;
    };
    const makeBooking = async (
      startAt,
      endAt,
      eligible,
      type = 'model',
      targetId = eligible[0],
    ) => {
      const row = (
        await db.pool.query(
          'INSERT INTO bookings(customer_id,start_at,end_at,target_type,target_model_id,target_group_id,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
          [
            customer,
            startAt,
            endAt,
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
    const block = async (startAt, endAt) =>
      (
        await db.pool.query(
          "INSERT INTO schedule_blocks(vehicle_id,kind,start_at,end_at,reason,created_by) VALUES ($1,'technical',$2,$3,'Preview test',$4) RETURNING id",
          [cars[0], startAt, endAt, actor],
        )
      ).rows[0].id;

    await t.test(
      'target resolution, saved model set and commercial inputs match without writes',
      async () => {
        for (const [type, id] of [
          ['vehicle', cars[0]],
          ['model', models[0]],
          ['brand', brand],
          ['equivalence_group', analogs],
        ]) {
          const result = await compare(input(type, id));
          assert.equal(result.availability.status, 'feasible');
        }
        for (const overrides of [
          {
            customDailyRateRub: '1234',
            mileageLimitKm: 777,
            discountRub: '100',
            reason: 'Ручные условия',
          },
          { customDailyRateRub: '1234', discountBps: 1250, reason: 'Проценты' },
          { customDailyRateRub: '0', mileageLimitKm: 0, reason: 'Нулевые условия' },
        ]) {
          const result = await compare(
            input('model', models[0], {
              pricing: {
                ...pricing,
                contractDays: 4,
                overrides,
                nonBillableDays: [{ dayIndex: 2, reason: 'Вых' }],
              },
            }),
          );
          assert.equal(result.calculation.contractDays, 4);
          assert.equal(result.calculation.billableDays, 3);
          assert.ok(result.calculation.overridesToConfirm.includes('price'));
        }
        const existing = await makeBooking(
          '2081-01-01',
          '2081-01-03',
          [models[0]],
          'equivalence_group',
          analogs,
        );
        const saved = await compare(
          input('equivalence_group', analogs, { bookingId: existing.id }),
        );
        assert.deepEqual(
          saved.alternatives.map((v) => v.modelId),
          [models[0]],
        );
        const changed = await compare(input('model', models[1], { bookingId: existing.id }));
        assert.deepEqual(
          changed.alternatives.map((v) => v.modelId),
          [models[1]],
        );
        await compare(input('vehicle', 2147483647), [422, 'EMPTY_TARGET']);
        await compare(input('model', models[0], { bookingId: 2147483647 }), [404, 'NOT_FOUND']);
        await db.pool.query('UPDATE vehicles SET archived_at=now() WHERE id=$1', [cars[0]]);
        await compare(input(), [422, 'EMPTY_TARGET']);
        await db.pool.query('UPDATE vehicles SET archived_at=NULL WHERE id=$1', [cars[0]]);
        const comfort = (
          await db.pool.query("SELECT id FROM pricing_groups WHERE tariff_code='comfort'")
        ).rows[0].id;
        await db.pool.query('UPDATE vehicle_models SET pricing_group_id=$1 WHERE id=$2', [
          comfort,
          models[2],
        ]);
        await compare(input('brand', brand), [422, 'TARIFF_AMBIGUOUS']);
        await db.pool.query('UPDATE vehicle_models SET pricing_group_id=$1 WHERE id=$2', [
          group,
          models[2],
        ]);
      },
    );

    await t.test(
      'strict DTO and pricing validation preserve complete errors and status',
      async () => {
        for (const body of [
          { ...input(), unknown: true },
          input('vehicle', -1),
          input('vehicle', cars[0], { bookingId: '1' }),
          ...[
            { startAt: 'invalid' },
            { startAt: '2080-01-01T00:00:00' },
            { contractDays: 0 },
            { contractDays: 1.5 },
            { dailyMileagePackageKm: 200 },
            { overrides: { customDailyRateRub: '0' } },
            { overrides: { discountRub: '1', discountBps: 10, reason: 'Два вида' } },
          ].map((changes) => input('vehicle', cars[0], { pricing: { ...pricing, ...changes } })),
        ])
          await compare(body, [400, 'VALIDATION_ERROR']);
        await compare(
          input('vehicle', cars[0], {
            pricing: { ...pricing, nonBillableDays: [{ dayIndex: 3, reason: 'За периодом' }] },
          }),
          [422, 'DAY_OUTSIDE_TERM'],
        );
      },
    );

    await t.test(
      'readiness, half-open technical intervals and full rental period match',
      async () => {
        await db.pool.query(
          "UPDATE vehicles SET is_ready=false,readiness_reason='Ремонт' WHERE id=$1",
          [cars[0]],
        );
        const notReady = await compare(input());
        assert.equal(notReady.availability.status, 'deficit');
        assert.ok(notReady.problemReasons.some((reason) => reason.includes('не готов')));
        await db.pool.query("UPDATE vehicles SET is_ready=true,readiness_reason='' WHERE id=$1", [
          cars[0],
        ]);
        const adjacent = await block('2080-01-03T00:00:00Z', '2080-01-04T00:00:00Z');
        assert.equal((await compare(input())).availability.status, 'feasible');
        const inside = await block('2080-01-02T23:00:00Z', '2080-01-03T00:00:00Z');
        const blocked = await compare(input());
        assert.equal(blocked.availability.status, 'deficit');
        assert.equal(blocked.conflicts.length, 1);
        assert.equal(blocked.conflicts[0].id, inside);
        await db.pool.query('DELETE FROM schedule_blocks WHERE id=ANY($1::int[])', [
          [adjacent, inside],
        ]);
      },
    );

    await t.test(
      'overlapping pools follow connected demands outside the preview period and preserve unknown',
      async () => {
        // Root model A ends Jan 3. A/B demand links to B-only demand starting Jan 4.
        const two = await makeBooking(
          '2080-01-02',
          '2080-01-05',
          models.slice(0, 2),
          'equivalence_group',
          analogs,
        );
        const three = await makeBooking('2080-01-04', '2080-01-06', [models[1]]);
        const four = await makeBooking('2080-01-04', '2080-01-06', [models[0]]);
        const deficit = await compare(input('model', models[0]));
        assert.equal(deficit.availability.status, 'deficit');
        assert.ok(deficit.availability.bookingIds.includes(three.id));
        assert.ok(deficit.availability.bookingIds.includes(four.id));
        await db.pool.query("UPDATE bookings SET status='cancelled' WHERE id=ANY($1::int[])", [
          [two.id, three.id, four.id],
        ]);
        // Each interval overlaps only its neighbours; root sees just the chain's beginning.
        const chain = (
          await db.pool.query(
            "INSERT INTO bookings(customer_id,start_at,end_at,target_type,target_model_id,created_by) SELECT $1,'2082-01-01'::timestamptz+n*interval '1 day','2082-01-01'::timestamptz+(n+2)*interval '1 day','model',$2,$3 FROM generate_series(1,501) n RETURNING id",
            [customer, models[0], actor],
          )
        ).rows.map((row) => row.id);
        await db.pool.query(
          'INSERT INTO booking_eligible_models(booking_id,model_id) SELECT unnest($1::int[]),$2',
          [chain, models[0]],
        );
        const unknown = await compare(
          input('model', models[0], { pricing: { ...pricing, startAt: '2082-01-01T00:00:00Z' } }),
        );
        assert.equal(unknown.availability.status, 'unknown');
        assert.deepEqual(unknown.availability.bookingIds, [0, ...chain]);
        assert.ok(unknown.problemReasons.includes('Доступность не подтверждена'));
      },
    );

    await t.test(
      'concurrent commit between pricing and availability stays outside each RR snapshot',
      async () => {
        const body = input('vehicle', cars[0], {
          pricing: { ...pricing, startAt: '2084-01-01T00:00:00Z' },
        });
        const stable = await compare(body);
        for (const owner of [reference, controller]) {
          const before = await snapshot();
          let inserted;
          afterQuery = async (sql) => {
            if (!sql.startsWith('SELECT DISTINCT p.id')) return;
            afterQuery = undefined;
            // Commit on a separate connection, after preview's snapshot was established by models().
            inserted = await block('2084-01-01T00:00:00Z', '2084-01-02T00:00:00Z');
          };
          try {
            const concurrent = await outcome(owner, body);
            assert.ok(inserted);
            assert.deepEqual(
              concurrent.value,
              stable,
              'price, both evaluations and exact HMAC use the old snapshot',
            );
            const fresh = await outcome(owner, body);
            assert.equal(fresh.value.availability.status, 'deficit');
            assert.notEqual(fresh.value.availability.token, stable.availability.token);
            assert.equal(fresh.value.previewToken, stable.previewToken);
          } finally {
            afterQuery = undefined;
            if (inserted)
              await db.pool.query('DELETE FROM schedule_blocks WHERE id=$1', [inserted]);
          }
          assert.deepEqual(
            await snapshot(),
            before,
            'only the explicitly injected concurrent row was written',
          );
        }
      },
    );
  },
);
