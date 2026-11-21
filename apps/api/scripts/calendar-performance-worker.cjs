// Test instrumentation only. The real HTTP bootstrap, SQL and solver still execute.
const profiler =
  process.env.CALENDAR_PROFILE_DIAGNOSTICS === '1'
    ? require('./calendar-profile-instrumentation.cjs')
    : undefined;
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { Pool } = require('pg');
const assert = require('node:assert/strict');
const solverTrace = require('./calendar-solver-trace.cjs');
let metrics;
let mode = 'current';
let pauseRead = false;
let resume;
const statements = new Map();
const measured = async (text, values, work) => {
  const active = metrics;
  const started = performance.now();
  if (active) {
    active.sqlCalls++;
    if (text.startsWith('SELECT v.id,v.model_id AS')) active.labelCalls++;
    if (text.startsWith('SELECT details FROM audit_logs')) active.displacementHistoryCalls++;
    if (text.startsWith('SELECT DISTINCT ON (entity_id)')) active.displacementBatchCalls++;
    else if (text.startsWith('SELECT DISTINCT ON')) active.displacedProjectionCalls++;
    if (text.startsWith('SELECT b.id,b.customer_id,b.version,b.status')) active.summaryTermsCalls++;
    if (text.includes('FROM finance_allocations WHERE booking_id')) active.summaryAllocationCalls++;
    if (text.includes("a.bucket='credit'")) active.summaryCreditCalls++;
  }
  try {
    const result = await work();
    if (active && /^SELECT/i.test(text) && !text.includes('sessions'))
      statements.set(text, { text, values });
    if (pauseRead && text.startsWith('SELECT v.*,m.name AS model_name')) {
      pauseRead = false;
      await new Promise((resolve) => {
        resume = resolve;
        process.send({ event: 'paused' });
      });
    }
    return result;
  } finally {
    if (active) active.sqlMs += performance.now() - started;
  }
};
const connect = Pool.prototype.connect;
Pool.prototype.connect = function (callback) {
  const wrap = (client) => {
    const query = client.query;
    const release = client.release;
    client.query = function (...args) {
      // Pool.query uses a callback; PoolClient.query in the application uses promises.
      const callback = typeof args.at(-1) === 'function' ? args.pop() : undefined;
      const pending = measured(args[0], args[1], () => query.apply(this, args));
      if (callback) {
        pending.then((result) => callback(null, result), callback);
        return;
      }
      return pending;
    };
    client.release = function (...args) {
      client.query = query;
      client.release = release;
      return release.apply(this, args);
    };
    return client;
  };
  if (callback)
    return connect.call(this, (error, client, release) => {
      if (error) return callback(error);
      wrap(client);
      callback(null, client, client.release);
    });
  return connect.call(this).then(wrap);
};
const availability = require('../dist/scheduling/availability');
const solve = availability.evaluateAvailability;
availability.evaluateAvailability = function (...args) {
  const solverInput = solverTrace.before(args);
  const started = performance.now();
  if (metrics) metrics.solverCalls++;
  try {
    const result = solve(...args);
    solverTrace.after(solverInput, result);
    return result;
  } finally {
    if (metrics) metrics.solverMs += performance.now() - started;
  }
};
const reference = require('../tests/fixtures/calendar-before-stage5.json');
function compile(source, file, overrides = {}) {
  const filename = path.resolve(__dirname, '../dist/scheduling', file);
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = module.paths;
  loaded.require = function (id) {
    return overrides[id] ?? Module.prototype.require.call(this, id);
  };
  loaded._compile(
    ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
      },
    }).outputText,
    filename,
  );
  return loaded.exports;
}
const LegacyScheduling = compile(
  reference.schedulingSource,
  'reference-scheduling.js',
).SchedulingService;
const LegacyCalendar = compile(reference.calendarSource, 'reference-calendar.js').CalendarService;
function traceEvaluations(prototype) {
  const evaluate = prototype.evaluate;
  prototype.evaluate = function (...args) {
    const log = metrics?.evaluations;
    const pending = evaluate.apply(this, args);
    if (!log) return pending;
    return pending.then((result) => {
      log.push({ input: args[1], result });
      return result;
    });
  };
}
traceEvaluations(require('../dist/scheduling/scheduling.service').SchedulingService.prototype);
const CurrentScheduling = require('../dist/scheduling/scheduling.service').SchedulingService;
const prepareFacts = CurrentScheduling.prototype.prepareAvailabilityFacts;
if (prepareFacts)
  CurrentScheduling.prototype.prepareAvailabilityFacts = function (...args) {
    const started = performance.now();
    const memory = process.memoryUsage().heapUsed;
    try {
      return prepareFacts.apply(this, args);
    } finally {
      if (metrics) {
        metrics.indexMs += performance.now() - started;
        metrics.indexHeapDelta += process.memoryUsage().heapUsed - memory;
      }
    }
  };
const { CalendarService } = require('../dist/scheduling/calendar.service');
const get = CalendarService.prototype.get;
const references = new WeakMap();
const beforeLabelsReferences = new WeakMap();
let beforeLabelsClasses;
const summarySnapshot = require('../tests/fixtures/calendar-before-stage5-3.json');
const originalLedger = compile(summarySnapshot.ledgerSource, 'before-summary-ledger.js');
const BeforeSummaryCalendar = compile(
  summarySnapshot.calendarSource,
  'before-summary-calendar.js',
  {
    '../finance/ledger': originalLedger,
  },
).CalendarService;
const beforeSummaryReferences = new WeakMap();
let currentCalendar;
const preparationSnapshot = require('../tests/fixtures/calendar-before-stage5-4.json');
const BeforePreparationScheduling = compile(
  preparationSnapshot.schedulingSource,
  'before-preparation-scheduling.js',
).SchedulingService;
profiler?.wrapScheduling(BeforePreparationScheduling);
traceEvaluations(BeforePreparationScheduling.prototype);
const BeforePreparationCalendar = compile(
  preparationSnapshot.calendarSource,
  'before-preparation-calendar.js',
).CalendarService;
profiler?.wrapCalendar(BeforePreparationCalendar);
const beforePreparationReferences = new WeakMap();
CalendarService.prototype.get = function (query) {
  currentCalendar = this;
  if (mode === 'before-preparation') {
    if (!beforePreparationReferences.has(this)) {
      const scheduling = new BeforePreparationScheduling(this.db, this.scheduling.commands);
      scheduling.tokenKey = this.scheduling.tokenKey;
      beforePreparationReferences.set(this, new BeforePreparationCalendar(this.db, scheduling));
    }
    return beforePreparationReferences.get(this).get(query);
  }
  if (mode === 'before-summary') {
    if (!beforeSummaryReferences.has(this))
      beforeSummaryReferences.set(this, new BeforeSummaryCalendar(this.db, this.scheduling));
    return beforeSummaryReferences.get(this).get(query);
  }
  if (mode === 'before-labels') {
    if (!beforeLabelsClasses) {
      const snapshot = require('../tests/fixtures/calendar-before-stage5-2.json');
      beforeLabelsClasses = {
        Scheduling: compile(snapshot.schedulingSource, 'before-labels-scheduling.js')
          .SchedulingService,
        Calendar: compile(snapshot.calendarSource, 'before-labels-calendar.js').CalendarService,
      };
      traceEvaluations(beforeLabelsClasses.Scheduling.prototype);
    }
    if (!beforeLabelsReferences.has(this)) {
      const scheduling = new beforeLabelsClasses.Scheduling(this.db, this.scheduling.commands);
      scheduling.tokenKey = this.scheduling.tokenKey;
      beforeLabelsReferences.set(this, new beforeLabelsClasses.Calendar(this.db, scheduling));
    }
    return beforeLabelsReferences.get(this).get(query);
  }
  if (mode === 'reference') {
    if (!references.has(this)) {
      const scheduling = new LegacyScheduling(this.db, this.scheduling.commands);
      // Test-only: compare HMACs as well, without disclosing either signing key.
      scheduling.tokenKey = this.scheduling.tokenKey;
      references.set(this, new LegacyCalendar(this.db, scheduling));
    }
    return references.get(this).get(query);
  }
  return get.call(this, query);
};
process.on('message', async ({ id, command, value }) => {
  if (command === 'preparation-cases' || command === 'single-evaluation') {
    try {
      const result = await currentCalendar.db.transaction(async (c) => {
        await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        const original = new BeforePreparationScheduling(
          currentCalendar.db,
          currentCalendar.scheduling.commands,
        );
        original.tokenKey = currentCalendar.scheduling.tokenKey;
        const current = currentCalendar.scheduling;
        const strip = ({ evaluatedAt, ...v }) => v;
        if (command === 'single-evaluation') {
          const indexBefore = metrics.indexMs;
          await original.evaluate(c, value);
          await current.evaluate(c, value);
          const runs = [];
          for (let i = 0; i < 5; i++) {
            const queries = metrics.sqlCalls;
            const before = performance.now();
            const expected = await original.evaluate(c, value);
            const beforeMs = performance.now() - before;
            const beforeSql = metrics.sqlCalls - queries;
            const after = performance.now();
            const actual = await current.evaluate(c, value);
            runs.push({
              beforeMs,
              afterMs: performance.now() - after,
              beforeSql,
              afterSql: metrics.sqlCalls - queries - beforeSql,
            });
            assert.deepEqual(strip(actual), strip(expected));
          }
          assert.equal(
            metrics.indexMs,
            indexBefore,
            'ordinary evaluate does not build calendar indices',
          );
          return { runs, indexMs: metrics.indexMs - indexBefore };
        }
        const oldFacts = await original.loadAvailabilityFacts(c),
          facts = await current.loadAvailabilityFacts(c);
        const ids = value.inputs
          .filter((v) => v.input.id !== undefined && !v.input.vehicleId)
          .map((v) => v.input.id);
        const oldInspect = await original.createCalendarInspector(c, oldFacts, ids),
          inspect = await current.createCalendarInspector(c, facts, ids);
        let calls = 0,
          ordinaryCalls = 0;
        const results = [];
        for (const { name, input } of value.inputs) {
          solverTrace.reset({ mode: 'record', path: value.solverTracePath });
          const expected = await oldInspect(input);
          solverTrace.finish();
          solverTrace.reset({ mode: 'compare', path: value.solverTracePath });
          const actual = await inspect(input);
          calls += solverTrace.finish().calls;
          assert.deepEqual(strip(actual.availability), strip(expected.availability));
          assert.deepEqual(
            { ...actual, availability: strip(actual.availability) },
            { ...expected, availability: strip(expected.availability) },
          );
          solverTrace.reset({ mode: 'record', path: value.solverTracePath });
          const oldOrdinary = await original.inspect(c, input);
          solverTrace.finish();
          solverTrace.reset({ mode: 'compare', path: value.solverTracePath });
          const ordinary = await current.inspect(c, input);
          ordinaryCalls += solverTrace.finish().calls;
          assert.deepEqual(
            { ...ordinary, availability: strip(ordinary.availability) },
            { ...oldOrdinary, availability: strip(oldOrdinary.availability) },
          );
          assert.deepEqual(strip(actual.availability), strip(ordinary.availability));
          results.push({
            name,
            status: actual.availability.status,
            steps: actual.availability.steps,
          });
        }
        return { cases: value.inputs.length, solverCalls: calls, ordinaryCalls, results };
      });
      process.send({ id, value: result });
    } catch (error) {
      process.send({ id, value: { error: error.stack } });
    }
    return;
  }
  if (command === 'summaries') {
    try {
      const ledger = require('../dist/finance/ledger');
      const result = await currentCalendar.db.transaction(async (c) => {
        await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        const original = [],
          individual = [];
        for (const bookingId of value) {
          original.push(await originalLedger.bookingSummary(c, bookingId));
          individual.push(await ledger.bookingSummary(c, bookingId));
        }
        const batchMap = ledger.bookingSummaries
          ? await ledger.bookingSummaries(c, value)
          : undefined;
        const beforeEmpty = metrics?.sqlCalls;
        const empty = ledger.bookingSummaries ? await ledger.bookingSummaries(c, []) : undefined;
        return {
          original,
          individual,
          batch: batchMap ? value.map((id) => batchMap.get(id)) : undefined,
          emptySize: empty?.size,
          emptyQueries: metrics ? metrics.sqlCalls - beforeEmpty : undefined,
        };
      });
      process.send({ id, value: result });
    } catch (error) {
      process.send({ id, value: { error: error.stack } });
    }
    return;
  }
  if (command === 'reset') {
    profiler?.reset(value?.profile);
    solverTrace.reset(value?.solverTrace);
    metrics = {
      sqlCalls: 0,
      sqlMs: 0,
      solverCalls: 0,
      solverMs: 0,
      indexMs: 0,
      indexHeapDelta: 0,
      memoryBefore: process.memoryUsage(),
      cpuBefore: process.cpuUsage(),
      labelCalls: 0,
      displacementHistoryCalls: 0,
      displacementBatchCalls: 0,
      displacedProjectionCalls: 0,
      summaryTermsCalls: 0,
      summaryAllocationCalls: 0,
      summaryCreditCalls: 0,
      ...(value?.traceEvaluations ? { evaluations: [] } : {}),
    };
    mode = value?.mode ?? 'current';
    pauseRead = value?.pauseRead ?? false;
  }
  if (command === 'resume') {
    resume?.();
    resume = undefined;
  }
  process.send({
    id,
    value:
      command === 'stats'
        ? {
            ...metrics,
            memoryAfter: process.memoryUsage(),
            cpu: process.cpuUsage(metrics.cpuBefore),
            solverTrace: solverTrace.finish(),
            statements: [...statements.values()],
            profile: profiler?.stats(),
          }
        : true,
  });
});
require('../dist/main');
