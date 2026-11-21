const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { withFinance } = require('./helpers/finance-regression.cjs');
const reference = require('./helpers/catalog-model-reference.cjs');
const { CatalogService } = require('../dist/catalog/catalog.service');
const { VehiclesController } = require('../dist/catalog/vehicles.controller');
const { CommandsService } = require('../dist/platform/commands.service');
const { vehicleInput } = require('../dist/catalog/catalog.dto');
const timestampFields = new Set([
  'created_at',
  'updated_at',
  'expires_at',
  'confirmed_at',
  'next_attempt_at',
]);
function normalize(value, key = '') {
  if (value !== null && timestampFields.has(key)) return '<service timestamp>';
  if (Array.isArray(value)) return value.map((item) => normalize(item));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v, k)]));
  if (typeof value === 'string' && /^[{[]/.test(value)) {
    try {
      return JSON.stringify(normalize(JSON.parse(value)));
    } catch {
      return value;
    }
  }
  return value;
}
async function setup(f, old) {
  const service = old
    ? new reference.CatalogService(f.db, new CommandsService(f.db))
    : new CatalogService(f.db, new CommandsService(f.db));
  const controller = old
    ? new reference.VehiclesController(service)
    : new VehiclesController(service);
  const model = (await f.db.pool.query('SELECT * FROM vehicle_models ORDER BY id LIMIT 1')).rows[0];
  const otherPricing = (
    await f.db.pool.query('SELECT id FROM pricing_groups WHERE id<>$1 ORDER BY id LIMIT 1', [
      model.pricing_group_id,
    ])
  ).rows[0].id;
  const request = (label) => {
    const value = createHash('sha256').update(label).digest('hex');
    return {
      ...f.request(),
      headers: { 'idempotency-key': 'stage24-' + label.padEnd(16, '_') },
      requestId: value.slice(0, 8) + '-0000-4000-8000-' + value.slice(8, 20),
    };
  };
  const data = {
    modelId: model.id,
    plate: 'A100BC78',
    vin: '',
    year: 2024,
    bodyType: 'sedan',
    transmission: 'automatic',
    currentMileageKm: 100,
    nextMaintenanceDueKm: 10000,
    isReady: true,
  };
  const base = await controller.create(data, request('fixture-vehicle'));
  const customer = (
    await f.db.pool.query(
      "INSERT INTO customers(type,display_name) VALUES ('individual','Stage 24 historical customer') RETURNING id",
    )
  ).rows[0].id;
  const booking = (
    await f.db.pool.query(
      "INSERT INTO bookings(customer_id,start_at,end_at,target_type,target_model_id,created_by) VALUES ($1,'2020-01-01','2020-01-03','model',$2,$3) RETURNING id",
      [customer, model.id, f.actor],
    )
  ).rows[0].id;
  await f.terms(booking, 1, '12345');
  await f.db.pool.query('INSERT INTO booking_eligible_models(booking_id,model_id) VALUES ($1,$2)', [
    booking,
    model.id,
  ]);
  await f.db.pool.query(
    "INSERT INTO schedule_blocks(vehicle_id,booking_id,kind,start_at,end_at,reason,created_by) VALUES ($1,$2,'assignment','2020-01-01','2020-01-03','Historical assignment',$3)",
    [base.id, booking, f.actor],
  );
  const operation = (
    await f.db.pool.query(
      "INSERT INTO financial_operations(command_id,request_hash,kind,customer_id,booking_id,actor_id,reason) VALUES ('stage24-fixture','historical','deposit_receipt',$1,$2,$3,'Historical cash') RETURNING id",
      [customer, booking, f.actor],
    )
  ).rows[0].id;
  const lot = (
    await f.db.pool.query(
      "INSERT INTO finance_lots(customer_id,original_operation_id,origin,method) VALUES ($1,$2,'deposit','cash') RETURNING id",
      [customer, operation],
    )
  ).rows[0].id;
  await f.db.pool.query(
    "INSERT INTO finance_allocations(operation_id,lot_id,bucket,booking_id,amount_rub,fund) VALUES ($1,$2,'deposit',$3,100,'deposit_pool')",
    [operation, lot, booking],
  );
  await f.db.pool.query(
    "INSERT INTO finance_fund_entries(operation_id,fund,amount_rub) VALUES ($1,'deposit_pool',100)",
    [operation],
  );
  await f.db.pool.query(
    "INSERT INTO finance_external(operation_id,method,amount_rub) VALUES ($1,'cash',100)",
    [operation],
  );
  return { ...f, controller, service, model, otherPricing, request, data, base, old };
}
async function observe(context, work) {
  let outcome;
  await context.observe(async () => {
    try {
      outcome = { result: await work(context) };
    } catch (error) {
      outcome = error.getStatus
        ? { status: error.getStatus(), body: error.getResponse() }
        : { sqlstate: error.code };
    }
  });
  assert.equal(
    new Set(context.trace.map((event) => event.pid)).size,
    1,
    'one transaction connection',
  );
  return {
    outcome,
    trace: context.trace.map(({ sql, values, ok, code, rowCount }) => ({
      sql,
      values: normalize(values),
      ok,
      code,
      rowCount,
    })),
  };
}

test('Catalog model move: frozen controller/service versus current commands on identical PostgreSQL history', async (t) => {
  await withFinance(async (leftFixture) => {
    const left = await setup(leftFixture, true);
    await withFinance(async (rightFixture) => {
      const right = await setup(rightFixture, false);
      const initial = await right.snapshot();
      const protectedTables = Object.keys(initial).filter(
        (name) =>
          name.startsWith('finance') ||
          name === 'financial_operations' ||
          [
            'bookings',
            'booking_terms',
            'booking_eligible_models',
            'booking_risks',
            'schedule_blocks',
            'pricing_quotes',
          ].includes(name),
      );
      async function step(label, work, expected = {}) {
        const beforeLeft = await left.snapshot(),
          beforeRight = await right.snapshot();
        assert.deepEqual(
          normalize(beforeRight),
          normalize(beforeLeft),
          label + ' identical starting state',
        );
        const a = await observe(left, work),
          b = await observe(right, work);
        // The frozen controller predates the check for active bookings.
        const comparableTrace = b.trace.filter(
          ({ sql }) => !sql.endsWith('AS "bookingIds" FROM vehicles v WHERE v.id=$1'),
        );
        assert.deepEqual({ ...b, trace: comparableTrace }, a, label + ' outcome / SQL / locks');
        if (expected.code) {
          assert.equal(b.outcome.status, expected.status ?? 422);
          assert.equal(b.outcome.body.code, expected.code);
        } else if (expected.sqlstate) assert.equal(b.outcome.sqlstate, expected.sqlstate);
        else assert.ok('result' in b.outcome, label + ' successful command');
        const afterLeft = await left.snapshot(),
          afterRight = await right.snapshot();
        assert.deepEqual(
          normalize(afterRight),
          normalize(afterLeft),
          label + ' full resulting rows / IDs / events / hashes',
        );
        if (expected.code || expected.sqlstate) {
          assert.deepEqual(afterLeft, beforeLeft, label + ' original rollback');
          assert.deepEqual(
            afterRight,
            beforeRight,
            label + ' current rollback, no orphan references or key result',
          );
        }
        for (const table of protectedTables)
          assert.deepEqual(afterRight[table], initial[table], label + ' preserved ' + table);
        return b;
      }
      const create = (context, label, changes) =>
        context.controller.create({ ...context.data, ...changes }, context.request(label));
      const free = (context, changes = {}) => ({
        ...context.data,
        modelId: undefined,
        brandName: '  Stage   24   Brand ',
        modelName: ' Fresh   Model ',
        pricingGroupId: context.model.pricing_group_id,
        ...changes,
      });
      const change = (context, label, overrides = {}) =>
        context.controller.update(
          String(context.base.id),
          { expectedVersion: 1, reason: 'Correct mileage', data: context.data, ...overrides },
          context.request(label),
        );
      await t.test(
        'resolver branches, normalization, explicit ID priority and existing tariff',
        async () => {
          await step('existing ID', (c) =>
            create(c, 'existing-id', {
              plate: 'A101BC78',
              brandName: 'Ignored',
              modelName: 'Ignored',
              pricingGroupId: 2147483647,
            }),
          );
          await step('new model existing brand', (c) =>
            c.controller.create(
              free(c, { brandName: ' regression ', modelName: 'Second Model', plate: 'A102BC78' }),
              c.request('existing-brand'),
            ),
          );
          await step('new brand/model', (c) =>
            c.controller.create(free(c, { plate: 'A103BC78' }), c.request('new-brand')),
          );
          await step('reuse case and spaces, preserve tariff', (c) =>
            c.controller.create(
              free(c, {
                brandName: 'stage  24 BRAND',
                modelName: 'fresh MODEL',
                pricingGroupId: c.otherPricing,
                plate: 'A104BC78',
              }),
              c.request('reuse-brand'),
            ),
          );
          const rows = await right.snapshot();
          const brand = rows.vehicle_brands.filter((row) => row.name === 'Stage 24 Brand');
          assert.equal(brand.length, 1);
          const models = rows.vehicle_models.filter((row) => row.brand_id === brand[0].id);
          assert.equal(models.length, 1);
          assert.equal(models[0].name, 'Fresh Model');
          assert.equal(models[0].pricing_group_id, right.model.pricing_group_id);
          const result = await step('direct resolver ID', (c) =>
            c.db.transaction(async (client) => {
              await client.query(
                "SELECT pg_advisory_xact_lock(hashtextextended('crm:schedule',0))",
              );
              const input = vehicleInput.parse(free(c));
              return c.old
                ? c.controller.model(client, input)
                : c.service.resolveVehicleModel(client, input);
            }),
          );
          assert.equal(result.outcome.result, models[0].id);
        },
      );
      await t.test('errors and priority, late validation and duplicate rollback', async () => {
        await step(
          'missing model',
          (c) => create(c, 'missing-model', { modelId: 2147483647, plate: 'A105BC78' }),
          { code: 'MODEL_NOT_FOUND' },
        );
        await step(
          'missing pricing with inserted brand',
          (c) =>
            c.controller.create(
              free(c, {
                brandName: 'Rolled back brand',
                modelName: 'No tariff',
                pricingGroupId: undefined,
                plate: 'A105BC78',
              }),
              c.request('missing-pricing'),
            ),
          { code: 'PRICING_GROUP_REQUIRED' },
        );
        await step(
          'nonexistent pricing',
          (c) =>
            c.controller.create(
              free(c, {
                brandName: 'Rolled back brand',
                pricingGroupId: 2147483647,
                plate: 'A105BC78',
              }),
              c.request('invalid-pricing'),
            ),
          { code: 'PRICING_GROUP_REQUIRED' },
        );
        await step(
          'stale version before resolver',
          (c) =>
            change(c, 'stale-first', {
              expectedVersion: 999,
              reason: '',
              data: { ...c.data, modelId: 2147483647, currentMileageKm: 101 },
            }),
          { code: 'VERSION_CONFLICT', status: 409 },
        );
        await step(
          'pricing error before missing comment',
          (c) =>
            change(c, 'pricing-first', {
              reason: '',
              data: free(c, {
                brandName: 'Rolled back update brand',
                pricingGroupId: undefined,
                currentMileageKm: 101,
              }),
            }),
          { code: 'PRICING_GROUP_REQUIRED' },
        );
        const late = await step(
          'resolver before missing comment',
          (c) =>
            change(c, 'comment-late', {
              reason: '',
              data: free(c, { brandName: 'Rolled back update brand', currentMileageKm: 101 }),
            }),
          { code: 'CHANGE_COMMENT_REQUIRED' },
        );
        assert.ok(
          late.trace.some(
            (event) => event.sql.startsWith('INSERT INTO vehicle_models') && event.ok,
          ),
        );
        await step(
          'duplicate vehicle after new references',
          (c) =>
            c.controller.create(
              free(c, { brandName: 'Rolled back duplicate brand' }),
              c.request('duplicate-create'),
            ),
          { code: 'VEHICLE_DUPLICATE', status: 409 },
        );
        await step(
          '23505 update after new references',
          (c) =>
            change(c, 'duplicate-update', {
              data: free(c, { brandName: 'Rolled back duplicate brand', plate: 'A101BC78' }),
            }),
          { code: 'VEHICLE_DUPLICATE', status: 409 },
        );
      });
      await t.test(
        'update result/version, original keys and fingerprints, no duplicate references',
        async () => {
          const updated = await step('successful update', (c) =>
            change(c, 'successful-update', { data: free(c, { currentMileageKm: 101 }) }),
          );
          assert.deepEqual(updated.outcome.result, { id: right.base.id, version: 2 });
          const replay = await step('update replay', (c) =>
            change(c, 'successful-update', { data: free(c, { currentMileageKm: 101 }) }),
          );
          assert.deepEqual(replay.outcome, updated.outcome);
          assert.equal(
            replay.trace.some((event) => event.sql.includes('FROM vehicle_models')),
            false,
          );
          await step(
            'update key body mismatch',
            (c) =>
              change(c, 'successful-update', {
                reason: 'Different body',
                data: free(c, { currentMileageKm: 101 }),
              }),
            { code: 'IDEMPOTENCY_KEY_REUSED', status: 409 },
          );
          await step('create replay', (c) =>
            c.controller.create(free(c, { plate: 'A103BC78' }), c.request('new-brand')),
          );
          await step(
            'create key body mismatch',
            (c) =>
              c.controller.create(
                free(c, { plate: 'A103BC78', year: 2023 }),
                c.request('new-brand'),
              ),
            { code: 'IDEMPOTENCY_KEY_REUSED', status: 409 },
          );
        },
      );
      await t.test(
        'audit and outbox faults roll back full commands; same key then succeeds',
        async () => {
          for (const table of ['audit_logs', 'outbox_jobs']) {
            for (const c of [left, right]) {
              await c.db.pool.query(
                "CREATE OR REPLACE FUNCTION stage24_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Stage 24 fault' USING ERRCODE='P0001'; END $$",
              );
              await c.db.pool.query(
                `CREATE TRIGGER stage24_fail BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION stage24_fail()`,
              );
            }
            const command = (c) =>
              c.controller.create(
                free(c, {
                  brandName: 'Fault ' + table,
                  plate: table === 'audit_logs' ? 'A110BC78' : 'A111BC78',
                }),
                c.request('fault-' + table),
              );
            try {
              await step(table + ' fault 1', command, { sqlstate: 'P0001' });
              await step(table + ' fault 2', command, { sqlstate: 'P0001' });
            } finally {
              for (const c of [left, right])
                await c.db.pool.query('DROP TRIGGER stage24_fail ON ' + table);
            }
            const posted = await step(table + ' recovered', command);
            assert.deepEqual((await step(table + ' replay', command)).outcome, posted.outcome);
          }
        },
      );
    });
  });
});
