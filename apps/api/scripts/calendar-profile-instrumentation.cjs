// Opt-in diagnostics inside a disposable worker; original function bodies are unchanged.
const assert = require('node:assert/strict');
const { AsyncLocalStorage } = require('node:async_hooks');
const crypto = require('node:crypto');
const { createHash } = crypto;
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { PerformanceObserver } = require('node:perf_hooks');
const { Pool } = require('pg');
const express = require('express');
const context = new AsyncLocalStorage();
const stringify = JSON.stringify;
const sourceHashes = Object.fromEntries(
  ['calendar.service', 'scheduling.service', 'availability'].map((file) => [
    file,
    createHash('sha256')
      .update(readFileSync(path.resolve(__dirname, '../src/scheduling', file + '.ts')))
      .digest('hex'),
  ]),
);
const diagnosticHash = createHash('sha256').update(readFileSync(__filename)).digest('hex');
let enabled = false;
let detailed = false;
let profile;
let requestStart;
let requestEnd;
let cpuStart;
let memoryStart;
let gc = [];
let previousSolverInput;
function start(name, metadata) {
  if (!enabled || !context.getStore()) return undefined;
  return { name, metadata, start: performance.now(), children: 0, parent: context.getStore() };
}
function finish(span) {
  if (!span) return;
  const ms = performance.now() - span.start;
  span.parent.children += ms;
  const row = (profile.spans[span.name] ??= { count: 0, inclusiveMs: 0, exclusiveMs: 0 });
  row.count++;
  row.inclusiveMs += ms;
  row.exclusiveMs += ms - span.children;
  return ms;
}
function sync(name, work) {
  const span = start(name);
  if (!span) return work();
  return context.run(span, () => {
    try {
      return work();
    } finally {
      finish(span);
    }
  });
}
async function asyncSpan(name, work, metadata) {
  const span = start(name, metadata);
  if (!span) return work();
  return context.run(span, async () => {
    try {
      return await work();
    } finally {
      finish(span);
    }
  });
}
const { SchedulingService } = require('../dist/scheduling/scheduling.service');
const { CalendarService } = require('../dist/scheduling/calendar.service');
function wrapScheduling(Scheduling) {
  for (const name of [
    'inspect',
    'inspectWithData',
    'evaluate',
    'loadAvailabilityFacts',
    'conflicts',
    'createCalendarInspector',
  ]) {
    const original = Scheduling.prototype[name];
    if (!original) continue;
    Scheduling.prototype[name] = function (...args) {
      if (!enabled) return original.apply(this, args);
      return asyncSpan(
        'scheduling.' + name,
        () => original.apply(this, args),
        name === 'evaluate' ? args[1] : undefined,
      );
    };
  }
  const prepare = Scheduling.prototype.prepareAvailabilityFacts;
  if (prepare)
    Scheduling.prototype.prepareAvailabilityFacts = function (...args) {
      return sync('scheduling.prepareAvailabilityFacts', () => prepare.apply(this, args));
    };
}
wrapScheduling(SchedulingService);
function wrapCalendar(Calendar) {
  const calendarGet = Calendar.prototype.get;
  Calendar.prototype.get = function (...args) {
    if (!enabled) return calendarGet.apply(this, args);
    return asyncSpan('calendar.get', () => calendarGet.apply(this, args));
  };
}
wrapCalendar(CalendarService);
const ledger = require('../dist/finance/ledger');
for (const name of ['bookingSummary', 'bookingSummaries']) {
  const summary = ledger[name];
  ledger[name] = function (...args) {
    if (!enabled) return summary.apply(this, args);
    return asyncSpan(name, () => summary.apply(this, args));
  };
}
const availability = require('../dist/scheduling/availability');
const solve = availability.evaluateAvailability;
availability.evaluateAvailability = function (demands, rootId, maxSteps) {
  if (!enabled || !context.getStore()) return solve(demands, rootId, maxSteps);
  let duration;
  const span = start('solver');
  let result;
  try {
    result = context.run(span, () => solve(demands, rootId, maxSteps));
  } finally {
    duration = finish(span);
  }
  sync('diagnostic.solverFacts', () => {
    let details;
    if (detailed) {
      const serialized = stringify({ demands, rootId, maxSteps: maxSteps ?? 100000 });
      const ids = new Set(result.bookingIds);
      const component = demands.filter((demand) => ids.has(demand.id));
      details = {
        signature: createHash('sha256').update(serialized).digest('hex'),
        sameAsPrevious: previousSolverInput === serialized,
        candidates: component.reduce((n, d) => n + d.candidates.length, 0),
        poolEntries: component.reduce((n, d) => n + (d.pool ?? d.candidates).length, 0),
        inputCandidates: demands.reduce((n, d) => n + d.candidates.length, 0),
      };
      previousSolverInput = serialized;
    }
    profile.solverCalls.push({
      rootId,
      context: context.getStore().parent?.metadata,
      ms: duration,
      demands: demands.length,
      inputCandidates: demands.reduce((n, d) => n + d.candidates.length, 0),
      inputPools: demands.reduce((n, d) => n + (d.pool ?? d.candidates).length, 0),
      component: result.bookingIds.length,
      steps: result.steps,
      status: result.status,
      ...details,
    });
  });
  return result;
};
JSON.stringify = function (...args) {
  const parent = context.getStore();
  if (!enabled || !parent) return stringify.apply(this, args);
  const name = 'json.' + parent.name;
  const value = sync(name, () => stringify.apply(this, args));
  profile.jsonCharacters[name] = (profile.jsonCharacters[name] ?? 0) + (value?.length ?? 0);
  return value;
};

const createHmac = crypto.createHmac;
crypto.createHmac = function (...args) {
  if (!enabled || context.getStore()?.name !== 'scheduling.evaluate')
    return createHmac.apply(this, args);
  return sync('hmac.create', () => createHmac.apply(this, args));
};
for (const method of ['update', 'digest']) {
  const original = crypto.Hmac.prototype[method];
  crypto.Hmac.prototype[method] = function (...args) {
    if (!enabled || context.getStore()?.name !== 'scheduling.evaluate')
      return original.apply(this, args);
    return sync('hmac.' + method, () => original.apply(this, args));
  };
}
function category(sql) {
  if (/^(BEGIN|COMMIT|ROLLBACK|SET )/.test(sql)) return 'transaction';
  if (sql.includes('sessions')) return 'authorization';
  if (sql.startsWith('SELECT v.*,m.name')) return 'calendar.vehicles';
  if (sql.startsWith('SELECT s.*,c.display_name')) return 'calendar.events';
  if (sql.startsWith('SELECT b.*,c.display_name')) return 'calendar.bookings';
  if (sql.startsWith('SELECT DISTINCT ON (entity_id)')) return 'inspect.displacement-history-batch';
  if (sql.startsWith('SELECT DISTINCT ON')) return 'calendar.displaced';
  if (sql.startsWith('SELECT id,model_id')) return 'facts.vehicles';
  if (sql.startsWith('SELECT id,vehicle_id,booking_id')) return 'facts.blocks';
  if (sql.startsWith('SELECT b.*,array')) return 'facts.bookings';
  if (sql.startsWith('SELECT b.id,b.customer_id')) return 'summary.terms-and-charges';
  if (sql.startsWith('SELECT bucket,') || sql.startsWith('SELECT booking_id,bucket,'))
    return 'summary.booking-allocations';
  if (
    sql.startsWith('SELECT coalesce(sum(a.amount_rub)') ||
    sql.startsWith('SELECT l.customer_id,coalesce(sum(a.amount_rub)')
  )
    return 'summary.customer-credit';
  if (sql.startsWith('SELECT v.id,v.model_id AS')) return 'inspect.labels';
  if (sql.startsWith('SELECT details FROM audit_logs')) return 'inspect.displacement-history';
  if (sql.includes("'unassigned' AS kind")) return 'inspect.unassigned-conflicts';
  if (sql.startsWith('SELECT s.id,') && sql.includes('JOIN vehicles v'))
    return 'inspect.pool-block-conflicts';
  if (sql.startsWith('SELECT s.id,')) return 'inspect.vehicle-conflicts';
  return 'unclassified';
}
const connect = Pool.prototype.connect;
Pool.prototype.connect = function (callback) {
  const wrap = (client) => {
    const query = client.query;
    const release = client.release;
    client.query = function (...args) {
      if (!enabled || !context.getStore()) return query.apply(this, args);
      const sql = args[0];
      const group = category(sql);
      const method = context.getStore().name;
      return asyncSpan('sql.' + group, async () => {
        const started = performance.now();
        const result = await query.apply(this, args);
        const ms = performance.now() - started;
        const entry = (profile.sql[group] ??= {
          count: 0,
          ms: 0,
          rows: 0,
          callers: {},
          maxMs: 0,
          parameters: {},
        });
        entry.count++;
        entry.ms += ms;
        entry.rows += result.rowCount ?? 0;
        entry.callers[method] = (entry.callers[method] ?? 0) + 1;
        if (detailed && group !== 'authorization') {
          const parameterKey = createHash('sha256')
            .update(stringify(args[1] ?? []))
            .digest('hex');
          entry.parameters[parameterKey] = (entry.parameters[parameterKey] ?? 0) + 1;
        }
        if (ms >= entry.maxMs && group !== 'authorization') {
          entry.maxMs = ms;
          entry.example = { text: sql, values: args[1] };
        }
        return result;
      });
    };
    client.release = function (...args) {
      client.query = query;
      client.release = release;
      return release.apply(this, args);
    };
    return client;
  };
  if (callback) {
    const span = start('pool.acquire');
    return connect.call(this, (error, client) => {
      finish(span);
      if (error) return callback(error);
      wrap(client);
      callback(null, client, client.release);
    });
  }
  return asyncSpan('pool.acquire', () => connect.call(this)).then(wrap);
};
for (const name of ['json', 'send']) {
  const original = express.response[name];
  express.response[name] = function (...args) {
    return sync('response.' + name, () => original.apply(this, args));
  };
}
const handle = express.application.handle;
express.application.handle = function (req, res, next) {
  if (!enabled || !req.url.startsWith('/api/v1/calendar')) return handle.call(this, req, res, next);
  const root = { name: 'http', children: 0 };
  requestStart = performance.now();
  cpuStart = process.cpuUsage();
  memoryStart = process.memoryUsage();
  res.once('finish', () => {
    requestEnd = performance.now();
    profile.serverMs = requestEnd - requestStart;
    profile.rootExclusiveMs = profile.serverMs - root.children;
    profile.cpu = process.cpuUsage(cpuStart);
    profile.memoryBefore = memoryStart;
    profile.memoryAfter = process.memoryUsage();
  });
  return context.run(root, () => handle.call(this, req, res, next));
};
const observer = new PerformanceObserver((entries) => gc.push(...entries.getEntries()));
observer.observe({ entryTypes: ['gc'] });
module.exports = {
  wrapScheduling,
  wrapCalendar,
  reset(active) {
    enabled = !!active;
    detailed = active === 'detailed';
    profile = {
      version: 'wrappers-v2',
      level: active,
      spans: {},
      sql: {},
      solverCalls: [],
      jsonCharacters: {},
    };
    requestStart = undefined;
    requestEnd = undefined;
    gc = [];
    previousSolverInput = undefined;
  },
  stats() {
    if (!enabled) return undefined;
    gc.push(...observer.takeRecords());
    profile.gc = gc
      .filter((entry) => entry.startTime >= requestStart && entry.startTime <= requestEnd)
      .map((entry) => ({ ms: entry.duration, kind: entry.detail?.kind }));
    profile.sourceHashes = sourceHashes;
    profile.diagnosticHash = diagnosticHash;
    const sum =
      Object.values(profile.spans).reduce((n, row) => n + row.exclusiveMs, 0) +
      profile.rootExclusiveMs;
    profile.accountingErrorMs = profile.serverMs - sum;
    assert.ok(
      Math.abs(profile.accountingErrorMs) < 0.01,
      'exclusive span accounting must conserve wall time',
    );
    return profile;
  },
};
