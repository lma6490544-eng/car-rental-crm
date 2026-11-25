// Untimed differential checks compare every serialized solver input/result in order.
// A single-line buffer avoids retaining all 882 full demand arrays in memory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let trace;
function line() {
  while (!trace.pending.includes('\n')) {
    const bytes = fs.readSync(trace.fd, trace.buffer, 0, trace.buffer.length, null);
    if (!bytes) {
      assert.equal(trace.pending, '', 'complete trace lines');
      return undefined;
    }
    // Solver inputs contain numeric IDs/bounds and ASCII field/status names only.
    trace.pending += trace.buffer.toString('utf8', 0, bytes);
  }
  const end = trace.pending.indexOf('\n');
  const value = trace.pending.slice(0, end);
  trace.pending = trace.pending.slice(end + 1);
  return value;
}
module.exports = {
  reset(config) {
    assert.ok(!trace, 'previous request trace was finished');
    if (!config) return;
    const directory = path.resolve(__dirname, '../../../.runtime');
    const filename = path.resolve(config.path);
    assert.equal(path.dirname(filename), directory);
    assert.match(path.basename(filename), /^crm_calendar_perf_[a-f0-9]{16}-solver.jsonl$/);
    assert.ok(['record', 'compare'].includes(config.mode));
    fs.mkdirSync(directory, { recursive: true });
    trace = {
      ...config,
      path: filename,
      fd: fs.openSync(filename, config.mode === 'record' ? 'w' : 'r'),
      count: 0,
      observed: 0,
      pending: '',
      buffer: Buffer.alloc(65536),
    };
  },
  before(args) {
    if (!trace) return;
    // Historical inspectors ran one extra solver for alternatives after each primary call.
    if (trace.primaryFromPairs && trace.observed++ % 2 === 1) return;
    return JSON.stringify({ demands: args[0], rootId: args[1], maxSteps: args[2] ?? 100000 });
  },
  after(input, result) {
    if (input === undefined) return;
    const value = '{"input":' + input + ',"result":' + JSON.stringify(result) + '}';
    if (trace.mode === 'record') fs.writeFileSync(trace.fd, value + '\n');
    else assert.equal(line(), value, 'complete ordered solver input/result at call ' + trace.count);
    trace.count++;
  },
  finish() {
    if (!trace) return undefined;
    if (trace.primaryFromPairs)
      assert.equal(trace.observed, trace.count * 2, 'complete historical evaluation pairs');
    if (trace.mode === 'compare') assert.equal(line(), undefined, 'no missing solver calls');
    fs.closeSync(trace.fd);
    const result = { mode: trace.mode, calls: trace.count };
    if (trace.mode === 'compare') fs.unlinkSync(trace.path);
    trace = undefined;
    return result;
  },
};
