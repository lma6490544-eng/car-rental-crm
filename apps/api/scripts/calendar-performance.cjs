const assert = require('node:assert/strict');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
const net = require('node:net');
const fs = require('node:fs/promises');
const { Pool } = require('pg');
const { drizzle } = require('drizzle-orm/node-postgres');
const { migrate } = require('drizzle-orm/node-postgres/migrator');
const root = path.resolve(__dirname, '../../..');
require('dotenv').config({ path: path.join(root, '.env'), quiet: true });
const scales = [
  { name: 'small', cars: 20, bookings: 50 },
  { name: 'medium', cars: 50, bookings: 200 },
  { name: 'target', cars: 100, bookings: 500 },
];
const day = 86400000;
const base = Date.parse('2055-01-01T00:00:00Z');
const at = (days) => new Date(base + days * day).toISOString();
async function fixture(db, scale) {
  const { passwordHash } = require('../dist/platform/security');
  const password = 'Benchmark-' + randomBytes(18).toString('hex');
  const actor = (
    await db.query(
      "INSERT INTO users(full_name,login,password_hash,role) VALUES ('Synthetic','calendar-performance',$1,'manager') RETURNING id",
      [await passwordHash(password)],
    )
  ).rows[0].id;
  const customer = (
    await db.query(
      "INSERT INTO customers(type,display_name) VALUES ('individual','Synthetic calendar customer') RETURNING id",
    )
  ).rows[0].id;
  const brand = (
    await db.query("INSERT INTO vehicle_brands(name) VALUES ('Synthetic') RETURNING id")
  ).rows[0].id;
  const group = (await db.query("SELECT id FROM pricing_groups WHERE tariff_code='economy'"))
    .rows[0].id;
  const models = [];
  for (let i = 0; i < 5; i++)
    models.push(
      (
        await db.query(
          'INSERT INTO vehicle_models(brand_id,name,pricing_group_id) VALUES ($1,$2,$3) RETURNING id',
          [brand, 'Model ' + i, group],
        )
      ).rows[0].id,
    );
  const pools = [];
  for (const [i, eligible] of [
    [0, models.slice(0, 2)],
    [1, models.slice(1, 3)],
    [2, models.slice(3, 5)],
  ]) {
    const id = (
      await db.query('INSERT INTO equivalence_groups(name) VALUES ($1) RETURNING id', ['Pool ' + i])
    ).rows[0].id;
    for (const model of eligible)
      await db.query('INSERT INTO equivalence_group_models(group_id,model_id) VALUES ($1,$2)', [
        id,
        model,
      ]);
    pools.push({ id, eligible });
  }
  const cars = [];
  for (let i = 0; i < scale.cars; i++)
    cars.push(
      (
        await db.query(
          "INSERT INTO vehicles(model_id,plate,year,body_type,current_mileage_km,next_maintenance_due_km,is_ready,readiness_reason) VALUES ($1,$2,2020,'sedan',100,10000,$3,$4) RETURNING *",
          [models[i % 5], 'PERF-' + i, i !== 0, i === 0 ? 'Synthetic not ready' : ''],
        )
      ).rows[0],
    );
  const quote = (
    await db.query(
      "INSERT INTO pricing_quotes(created_by,confirmed_by,expires_at,confirmed_at,version,input,snapshot,confirmed_overrides) VALUES ($1,$1,'2100-01-01',now(),2,'{}',$2,'[]') RETURNING id",
      [actor, JSON.stringify({ finalTotalRub: '10000' })],
    )
  ).rows[0].id;
  const assigned = Math.floor(scale.bookings / 2);
  const displaced = [];
  for (let i = 0; i < scale.bookings; i++) {
    const j = i - assigned;
    const pool = j >= 0 && j % 3 === 0 ? pools[Math.floor(j / 3) % pools.length] : undefined;
    let modelIndex = i % 5;
    let start = Math.floor(i / scale.cars) * 3;
    if (i >= assigned) {
      modelIndex = j % 3 === 2 ? 3 : j % 5;
      start = j % 3 === 2 ? 18 + Math.floor(j / 3) * 0.5 : 10 + (j % 5) * 0.5;
    }
    const eligible = pool?.eligible ?? [models[modelIndex]];
    const end = start + (j >= 0 && j % 3 === 2 ? 1 : 2);
    let type = 'model';
    if (i < assigned) type = 'vehicle';
    else if (pool) type = 'equivalence_group';
    const car = cars[i % cars.length];
    const b = (
      await db.query(
        'INSERT INTO bookings(customer_id,start_at,end_at,target_type,target_vehicle_id,target_model_id,target_group_id,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
        [
          customer,
          at(start),
          at(end),
          type,
          type === 'vehicle' ? car.id : null,
          type === 'model' ? eligible[0] : null,
          pool?.id ?? null,
          actor,
        ],
      )
    ).rows[0].id;
    for (const model of eligible)
      await db.query('INSERT INTO booking_eligible_models(booking_id,model_id) VALUES ($1,$2)', [
        b,
        model,
      ]);
    await db.query(
      "INSERT INTO booking_terms(booking_id,revision,quote_id,snapshot,reason,created_by) VALUES ($1,1,$2,$3,'Synthetic',$4)",
      [
        b,
        quote,
        JSON.stringify({ finalTotalRub: '10000', startAt: at(start), agreedReturnAt: at(end) }),
        actor,
      ],
    );
    if (i < assigned)
      await db.query(
        "INSERT INTO schedule_blocks(vehicle_id,booking_id,kind,start_at,end_at,reason,created_by) VALUES ($1,$2,'assignment',$3,$4,'Synthetic',$5)",
        [car.id, b, at(start), at(end), actor],
      );
    else if (j < 6 && j % 3 !== 2)
      displaced.push({ b, start, end, car: cars.find((c) => eligible.includes(c.model_id)) });
  }
  // Dense components include explicitly blocked demand; separate long chains remain feasible.
  // This deterministic mixed profile avoids an unbounded benchmark of adversarial backtracking.
  for (let i = 0; i < cars.length; i++) {
    if (i >= 5 && ![models[0], models[3]].includes(cars[i].model_id)) continue;
    await db.query(
      "INSERT INTO schedule_blocks(vehicle_id,kind,start_at,end_at,reason,created_by) VALUES ($1,'technical',$2,$3,'Synthetic repair',$4)",
      [cars[i].id, at(10), at(17), actor],
    );
  }
  for (const d of displaced) {
    await db.query(
      "INSERT INTO schedule_blocks(vehicle_id,booking_id,kind,start_at,end_at,reason,created_by,retired_at) VALUES ($1,$2,'assignment',$3,$4,'Synthetic old assignment',$5,now())",
      [d.car.id, d.b, at(d.start), at(d.end), actor],
    );
    await db.query(
      "INSERT INTO audit_logs(actor_id,entity_type,entity_id,action,request_id,details) VALUES ($1,'booking',$2,'bookings.displaced',$3,$4)",
      [
        actor,
        d.b,
        randomUUID(),
        JSON.stringify({ previousVehicleId: d.car.id, reason: 'Synthetic repair' }),
      ],
    );
  }
  await db.query('ANALYZE');
  return { password, changeVehicle: cars[1].id };
}
const normalize = (value) =>
  Array.isArray(value)
    ? value.map(normalize)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([k]) => k !== 'evaluatedAt')
            .map(([k, v]) => [k, normalize(v)]),
        )
      : value;
async function runCalendarProfile({
  label = 'measurement',
  samples = 5,
  selected = scales,
  compare = false,
  timedMode = 'current',
  diagnostics = false,
  baselineMode,
  compareBeforeLabels = false,
  metadataRegression = false,
  compareBeforeSummary = false,
  financeProfile = false,
  financeRegression = false,
  comparePreparation = false,
  preparationRegression = false,
} = {}) {
  assert.match(label, /^[a-z0-9-]+$/);
  assert.ok(['current', 'reference'].includes(timedMode));
  assert.ok(
    !baselineMode ||
      ['before-labels', 'before-summary', 'before-preparation'].includes(baselineMode),
  );
  assert.ok(
    !baselineMode || !diagnostics || baselineMode === 'before-preparation',
    'Paired optimization measurements exclude the detailed profiler',
  );
  const withControls = diagnostics || !!baselineMode;
  const controlMode = baselineMode ?? timedMode;
  assert.ok(!compare || timedMode === 'current', 'Differential checks require the current mode');
  assert.ok(
    !diagnostics || timedMode === 'current',
    'Detailed profiling uses the current implementation',
  );
  const results = [];
  for (const scale of selected) {
    const name = 'crm_calendar_perf_' + randomBytes(8).toString('hex');
    const url = new URL(process.env.DATABASE_URL);
    const admin = new Pool({ connectionString: url.toString() });
    url.pathname = '/' + name;
    let db, child;
    const solverTracePath = path.join(root, '.runtime', name + '-solver.jsonl');
    try {
      await admin.query('CREATE DATABASE "' + name + '"');
      db = new Pool({ connectionString: url.toString() });
      await migrate(drizzle(db), { migrationsFolder: path.join(root, 'apps/api/drizzle') });
      const setup = await fixture(db, scale);
      if (financeProfile) await require('./calendar-finance-fixture.cjs').populateFinance(db);
      const uniqueCustomers = Number(
        (await db.query('SELECT count(DISTINCT customer_id) AS count FROM bookings')).rows[0].count,
      );
      const port = await new Promise((resolve) => {
        const server = net.createServer();
        server.listen(0, '127.0.0.1', () => {
          const p = server.address().port;
          server.close(() => resolve(p));
        });
      });
      const origin = 'http://127.0.0.1:' + port;
      child = spawn(process.execPath, [path.join(__dirname, 'calendar-performance-worker.cjs')], {
        cwd: root,
        env: {
          ...process.env,
          DATABASE_URL: url.toString(),
          NODE_ENV: 'test',
          API_PORT: String(port),
          APP_ORIGINS: origin,
          CALENDAR_PROFILE_DIAGNOSTICS: diagnostics ? '1' : '0',
        },
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      const errors = [];
      child.stderr.on('data', (data) => errors.push(data.toString()));
      let ready = false;
      for (let i = 0; i < 200; i++) {
        try {
          if ((await fetch(origin + '/api/v1/health')).ok) {
            ready = true;
            break;
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(ready, errors.join(''));
      let serial = 0;
      const rpc = (command, value) =>
        new Promise((resolve, reject) => {
          const id = ++serial;
          const timer = setTimeout(() => {
            child.off('message', listener);
            reject(new Error('Worker IPC timeout: ' + command));
          }, 30000);
          const listener = (m) => {
            if (m.id !== id) return;
            clearTimeout(timer);
            child.off('message', listener);
            resolve(m.value);
          };
          child.on('message', listener);
          child.send({ id, command, value });
        });
      const waitForPause = () =>
        new Promise((resolve) => {
          const listener = (message) => {
            if (message.event === 'paused') {
              child.off('message', listener);
              resolve();
            }
          };
          child.on('message', listener);
        });
      const login = await fetch(origin + '/api/v1/auth/login', {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ login: 'calendar-performance', password: setup.password }),
      });
      assert.equal(login.status, 200);
      const cookie = login.headers.get('set-cookie').split(';')[0];
      const getBooking = async (id) => {
        const response = await fetch(origin + '/api/v1/bookings/' + id, {
          headers: { Cookie: cookie },
        });
        assert.equal(response.status, 200);
        return response.json();
      };
      const parallelWindows = async (queries) => {
        const read = async (query) => {
          const response = await fetch(origin + '/api/v1/calendar?' + new URLSearchParams(query), {
            headers: { Cookie: cookie },
            signal: AbortSignal.timeout(120000),
          });
          assert.equal(response.status, 200);
          return response.json();
        };
        await rpc('reset', { mode: 'before-preparation' });
        const expected = [];
        for (const query of queries) expected.push(await read(query));
        await rpc('reset', { mode: 'current' });
        const actual = await Promise.all(queries.map(read));
        assert.deepEqual(
          normalize(actual),
          normalize(expected),
          'independent concurrent HTTP windows match the frozen service',
        );
      };
      const endpoint =
        origin +
        '/api/v1/calendar?from=' +
        encodeURIComponent(at(0)) +
        '&to=' +
        encodeURIComponent(at(30));
      const request = async (
        mode = 'current',
        pauseRead = false,
        profile = false,
        traceEvaluations = false,
        solverTrace,
      ) => {
        await rpc('reset', { mode, pauseRead, profile, traceEvaluations, solverTrace });
        const started = performance.now();
        const response = await fetch(endpoint, {
          headers: { Cookie: cookie },
          signal: AbortSignal.timeout(120000),
        });
        const body = await response.text();
        assert.equal(response.status, 200, body);
        const ms = performance.now() - started;
        return {
          data: JSON.parse(body),
          ms,
          bytes: Buffer.byteLength(body),
          ...(await rpc('stats')),
        };
      };
      const observation = (v) => ({
        ms: v.ms,
        bytes: v.bytes,
        sqlCalls: v.sqlCalls,
        sqlMs: v.sqlMs,
        solverCalls: v.solverCalls,
        solverMs: v.solverMs,
        indexMs: v.indexMs,
        indexHeapDelta: v.indexHeapDelta,
        heapDelta: v.memoryAfter.heapUsed - v.memoryBefore.heapUsed,
        memoryBefore: v.memoryBefore,
        memoryAfter: v.memoryAfter,
        cpu: v.cpu,
        inspectedBookings: v.data.bookings.length,
        summaryTermsCalls: v.summaryTermsCalls,
        summaryAllocationCalls: v.summaryAllocationCalls,
        summaryCreditCalls: v.summaryCreditCalls,
        labelCalls: v.labelCalls,
        displacementHistoryCalls: v.displacementHistoryCalls,
        displacementBatchCalls: v.displacementBatchCalls,
        displacedProjectionCalls: v.displacedProjectionCalls,
        ...(v.profile ? { profile: v.profile } : {}),
      });
      const controls = [];
      let control;
      if (withControls) {
        await request(
          controlMode,
          false,
          baselineMode === 'before-preparation' && diagnostics ? 'timing' : false,
        );
      }
      await request(timedMode, false, diagnostics ? 'timing' : false); // warmup, excluded from reported measurements
      const runs = [];
      for (let i = 0; i < samples; i++) {
        if (withControls) {
          control = await request(
            controlMode,
            false,
            baselineMode === 'before-preparation' && diagnostics ? 'timing' : false,
          );
          controls.push(observation(control));
          console.log(label, scale.name, 'control', i + 1, JSON.stringify(controls.at(-1)));
        }
        const v = await request(timedMode, false, diagnostics ? 'timing' : false);
        runs.push(observation(v));
        if (baselineMode)
          assert.deepEqual(
            normalize(v.data),
            normalize(control.data),
            'paired before-labels/current full responses including HMAC must match',
          );
        console.log(
          label,
          scale.name,
          'sample',
          i + 1,
          JSON.stringify({
            ms: v.ms,
            bytes: v.bytes,
            sqlCalls: v.sqlCalls,
            sqlMs: v.sqlMs,
            solverCalls: v.solverCalls,
            solverMs: v.solverMs,
            labelCalls: v.labelCalls,
            displacementHistoryCalls: v.displacementHistoryCalls,
            displacementBatchCalls: v.displacementBatchCalls,
          }),
        );
      }
      const current = await request(
        timedMode,
        false,
        diagnostics ? 'detailed' : false,
        compareBeforeLabels || compareBeforeSummary || comparePreparation,
      );
      if (comparePreparation) {
        const before = await request('before-preparation', false, false, true, {
          mode: 'record',
          primaryFromPairs: true,
          path: solverTracePath,
        });
        const after = await request('current', false, false, true, {
          mode: 'compare',
          path: solverTracePath,
        });
        assert.deepEqual(
          normalize(after.data),
          normalize(before.data),
          'full pre-5.4 calendar response and HMAC',
        );
        assert.deepEqual(
          normalize(after.evaluations),
          normalize(before.evaluations.filter((_, i) => i % 2 === 0)),
          'primary evaluation inputs, results and signatures',
        );
        assert.equal(after.solverTrace.calls, after.data.bookings.length);
        assert.equal(before.solverTrace.calls * 2, before.solverCalls);
        console.log(
          'complete solver input/result equivalence passed:',
          scale.name,
          after.solverTrace.calls,
        );
      }
      let singleEvaluation;
      if (comparePreparation) {
        const b = current.data.unassignedBookings[0] ?? current.data.problems[0];
        assert.ok(b);
        singleEvaluation = await rpc('single-evaluation', {
          id: b.id,
          target: {
            type: b.target_type,
            id: b.target_vehicle_id ?? b.target_model_id ?? b.target_brand_id ?? b.target_group_id,
          },
          models: b.models,
          startAt: b.start_at,
          endAt: b.end_at,
          vehicleId: b.vehicle_id,
        });
        assert.ok(!singleEvaluation.error, singleEvaluation.error);
      }
      if (compareBeforeSummary) {
        const beforeSummary = await request('before-summary', false, false, true);
        assert.deepEqual(
          normalize(current.data),
          normalize(beforeSummary.data),
          'full pre-5.3 calendar response',
        );
        assert.equal(current.evaluations.length, current.solverCalls);
        assert.deepEqual(
          normalize(current.evaluations),
          normalize(beforeSummary.evaluations),
          'primary evaluation and HMAC before 5.3',
        );
        const ids = current.data.bookings.map((b) => b.id);
        const summaries = await rpc('summaries', ids);
        assert.ok(!summaries.error, summaries.error);
        assert.deepEqual(
          summaries.individual,
          summaries.original,
          'ordinary summary matches frozen financial formulas',
        );
        if (summaries.batch)
          assert.deepEqual(
            summaries.batch,
            summaries.original,
            'batch summary matches every original individual result',
          );
        console.log('before-summary equivalence passed:', scale.name, ids.length, 'bookings');
      }
      if (compareBeforeLabels) {
        const beforeLabels = await request('before-labels', false, false, true);
        assert.deepEqual(
          normalize(current.data),
          normalize(beforeLabels.data),
          'full response including order, labels, reasons, projections and HMAC must match before stage 5.2',
        );
        assert.equal(current.solverCalls * 2, beforeLabels.solverCalls);
        assert.equal(current.evaluations.length, current.solverCalls);
        assert.deepEqual(
          normalize(current.evaluations),
          normalize(beforeLabels.evaluations.filter((_, i) => i % 2 === 0)),
          'primary evaluations and HMAC must match',
        );
        console.log('before-labels equivalence passed:', scale.name);
      }
      if (diagnostics) {
        assert.deepEqual(
          normalize(current.data),
          normalize(control.data),
          'instrumented and original current code must return the complete same response',
        );
        assert.equal(current.sqlCalls, control.sqlCalls);
        assert.equal(current.solverCalls, control.solverCalls);
        console.log('diagnostic equivalence passed:', scale.name);
      }
      if (compare) {
        const reference = await request('reference');
        assert.deepEqual(
          normalize(current.data),
          normalize(reference.data),
          'complete response including ordering and HMAC must match the frozen implementation',
        );
        const paused = new Promise((resolve) => {
          const listener = (m) => {
            if (m.event === 'paused') {
              child.off('message', listener);
              resolve();
            }
          };
          child.on('message', listener);
        });
        const pending = request('current', true);
        pending.catch(() => {}); // Cleanup may stop a paused worker after another assertion fails.
        await paused;
        try {
          await db.query(
            "UPDATE vehicles SET is_ready=false,readiness_reason='Concurrent synthetic repair' WHERE id=$1",
            [setup.changeVehicle],
          );
        } finally {
          await rpc('resume');
        }
        const during = await pending;
        assert.deepEqual(
          normalize(during.data),
          normalize(current.data),
          'concurrent commit cannot mix REPEATABLE READ snapshots',
        );
        const fresh = await request();
        assert.equal(fresh.data.vehicles.find((v) => v.id === setup.changeVehicle).is_ready, false);
        assert.deepEqual(
          normalize(fresh.data),
          normalize((await request('reference')).data),
          'next request observes committed facts without cross-request cache',
        );
        await db.query("UPDATE vehicles SET is_ready=true,readiness_reason='' WHERE id=$1", [
          setup.changeVehicle,
        ]);
        console.log('equivalence and concurrent snapshot passed:', scale.name);
      }
      if (metadataRegression) {
        await require('./calendar-metadata-regression.cjs')({
          db,
          request,
          rpc,
          waitForPause,
          getBooking,
        });
        console.log('labels/audit metadata regression passed:', scale.name);
      }
      if (financeRegression) {
        await require('./calendar-finance-regression.cjs')({ db, request, rpc, waitForPause });
        console.log('financial summary regression passed:', scale.name);
      }
      if (preparationRegression)
        await require('./calendar-preparation-regression.cjs')({
          db,
          request,
          rpc,
          waitForPause,
          solverTracePath,
          parallelWindows,
        });
      const plans = [];
      for (const statement of current.statements) {
        const plan = (
          await db.query(
            'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + statement.text,
            statement.values,
          )
        ).rows[0]['QUERY PLAN'];
        plans.push({ sql: statement.text, plan });
      }
      const sorted = runs.map((v) => v.ms).sort((a, b) => a - b);
      results.push({
        scale,
        postgres: (await db.query('SHOW server_version')).rows[0].server_version,
        runs,
        ...(baselineMode ? { controls, controlMode } : {}),
        ...(diagnostics
          ? { controls, detail: observation(current), diagnosticEquivalent: true }
          : {}),
        medianMs: sorted[Math.floor(sorted.length / 2)],
        minMs: sorted[0],
        maxMs: sorted.at(-1),
        visibleBookings: current.data.bookings.length,
        uniqueCustomers,
        ...(singleEvaluation ? { singleEvaluation } : {}),
        ...(compareBeforeSummary ? { comparedSummaryEvaluations: current.evaluations.length } : {}),
        ...(comparePreparation
          ? { comparedPreparationEvaluations: current.evaluations.length }
          : {}),
        ...(compareBeforeLabels ? { comparedEvaluations: current.evaluations.length } : {}),
        statuses: current.data.problems.reduce((a, b) => {
          const k = b.availability.status;
          a[k] = (a[k] ?? 0) + 1;
          return a;
        }, {}),
        plans,
      });
    } finally {
      if (child && child.exitCode === null) {
        const stopped = once(child, 'exit');
        child.kill();
        await Promise.race([stopped, new Promise((r) => setTimeout(r, 3000))]);
      }
      if (db) await db.end();
      await fs.rm(solverTracePath, { force: true });
      assert.match(name, /^crm_calendar_perf_[a-f0-9]{16}$/);
      await admin.query('DROP DATABASE IF EXISTS "' + name + '" WITH (FORCE)');
      await admin.end();
    }
  }
  const directory = path.join(
    root,
    comparePreparation || preparationRegression || baselineMode === 'before-preparation'
      ? 'outputs/backend-refactoring-stage-5-4'
      : compareBeforeSummary ||
          financeProfile ||
          financeRegression ||
          baselineMode === 'before-summary'
        ? 'outputs/backend-refactoring-stage-5-3'
        : baselineMode || compareBeforeLabels || metadataRegression
          ? 'outputs/backend-refactoring-stage-5-2'
          : diagnostics
            ? 'outputs/backend-refactoring-stage-5-1'
            : 'outputs/backend-refactoring-stage-5',
  );
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, label + '.json'),
    JSON.stringify(
      {
        label,
        samples,
        timedMode,
        diagnostics,
        baselineMode,
        compareBeforeLabels,
        metadataRegression,
        compareBeforeSummary,
        financeRegression,
        comparePreparation,
        preparationRegression,
        profile: financeProfile ? 'finance-v1' : 'mixed-v2',
        ...(financeProfile
          ? {
              financeFixtureHash: createHash('sha256')
                .update(await fs.readFile(path.join(__dirname, 'calendar-finance-fixture.cjs')))
                .digest('hex'),
            }
          : {}),
        fixtureHash: createHash('sha256')
          .update(await fs.readFile(__filename))
          .digest('hex'),
        fixtureSeedHash: createHash('sha256').update(fixture.toString()).digest('hex'),
        node: process.version,
        platform: process.platform,
        cpu: os.cpus()[0].model,
        note: 'One warmup; empirical median/range only, no P95 claim. Loopback HTTP includes SessionGuard, serialization, SQL and solver.',
        results,
      },
      null,
      2,
    ),
  );
  return results;
}
module.exports = { runCalendarProfile, scales };
if (require.main === module) {
  const label = process.argv[2] ?? 'measurement';
  const samples = Number(process.argv[3] ?? 5);
  assert.ok(Number.isInteger(samples) && samples > 0);
  runCalendarProfile({
    label,
    samples,
    compare: process.argv.includes('--compare'),
    timedMode: process.argv.includes('--reference') ? 'reference' : 'current',
    diagnostics: process.argv.includes('--diagnostics'),
    baselineMode: process.argv.includes('--before-preparation-control')
      ? 'before-preparation'
      : process.argv.includes('--before-summary-control')
        ? 'before-summary'
        : process.argv.includes('--before-labels-control')
          ? 'before-labels'
          : undefined,
    compareBeforeLabels: process.argv.includes('--compare-before-labels'),
    compareBeforeSummary: process.argv.includes('--compare-before-summary'),
    financeProfile: process.argv.includes('--finance-profile'),
    financeRegression: process.argv.includes('--finance-regression'),
    comparePreparation: process.argv.includes('--compare-preparation'),
    selected: process.argv.includes('--target-only')
      ? scales.slice(2)
      : process.argv.includes('--medium-target')
        ? scales.slice(1)
        : scales,
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
