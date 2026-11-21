// Summarize measured artifacts; never connect to a database or run application code.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const sorted = (values) => [...values].sort((a, b) => a - b);
const quantile = (values, q) => sorted(values)[Math.max(0, Math.ceil(values.length * q) - 1)];
const distribution = (values, tails = true) => ({
  n: values.length,
  total: values.reduce((n, v) => n + v, 0),
  min: Math.min(...values),
  median:
    (sorted(values)[Math.floor((values.length - 1) / 2)] +
      sorted(values)[Math.floor(values.length / 2)]) /
    2,
  ...(tails ? { p95: quantile(values, 0.95) } : {}),
  max: Math.max(...values),
});
async function summarize(file) {
  const input = JSON.parse(await fs.readFile(file, 'utf8'));
  const result = input.results.map((scale) => {
    const ordered = [...scale.runs].sort((a, b) => a.ms - b.ms);
    const representative = ordered[Math.floor(ordered.length / 2)];
    const p = representative.profile;
    const detail = scale.detail.profile;
    assert.equal(p.version, 'wrappers-v2');
    assert.equal(p.solverCalls.length, detail.solverCalls.length);
    for (let i = 0; i < p.solverCalls.length; i++) {
      for (const field of ['rootId', 'status', 'steps', 'component', 'demands'])
        assert.deepEqual(p.solverCalls[i][field], detail.solverCalls[i][field]);
    }
    const byComponent = {};
    const byStatus = {};
    const hashes = new Set();
    let exactRepeats = 0;
    let repeatedMs = 0;
    for (let i = 0; i < p.solverCalls.length; i++) {
      const call = p.solverCalls[i];
      (byComponent[call.component] ??= []).push(call.ms);
      (byStatus[call.status] ??= []).push(call.ms);
      const facts = detail.solverCalls[i];
      hashes.add(facts.signature);
      if (facts.sameAsPrevious) {
        exactRepeats++;
        repeatedMs += call.ms;
      }
    }
    const sql = Object.entries(p.sql).map(([name, row]) => ({
      name,
      count: row.count,
      totalMs: row.ms,
      averageMs: row.ms / row.count,
      rows: row.rows,
      callers: row.callers,
      uniqueParameterSets: Object.keys(detail.sql[name].parameters).length,
      largestRepeatedParameterSet: Math.max(0, ...Object.values(detail.sql[name].parameters)),
    }));
    assert.equal(
      sql.reduce((n, row) => n + row.count, 0),
      representative.sqlCalls,
    );
    const sqlSpanMs = Object.entries(p.spans)
      .filter(([key]) => key.startsWith('sql.'))
      .reduce((n, [, row]) => n + row.exclusiveMs, 0);
    const exclusive = Object.entries(p.spans)
      .filter(([key]) => !key.startsWith('sql.'))
      .map(([name, row]) => ({ name, ...row }));
    return {
      scale: scale.scale,
      visibleBookings: scale.visibleBookings,
      originalControlHttp: distribution(
        scale.controls.map((run) => run.ms),
        false,
      ),
      profiledHttp: distribution(
        scale.runs.map((run) => run.ms),
        false,
      ),
      representativeHttpMs: representative.ms,
      serverMs: p.serverMs,
      calendarMs: p.spans['calendar.get'].inclusiveMs,
      clientOutsideServerMs: representative.ms - p.serverMs,
      sqlCalls: representative.sqlCalls,
      sqlSpanMs,
      sqlDriverMs: sql.reduce((n, row) => n + row.totalMs, 0),
      sql,
      exclusive,
      rootExclusiveMs: p.rootExclusiveMs,
      accountingErrorMs: p.accountingErrorMs,
      solverCalls: p.solverCalls.length,
      solver: distribution(p.solverCalls.map((call) => call.ms)),
      byComponent: Object.fromEntries(
        Object.entries(byComponent).map(([key, ms]) => [key, distribution(ms)]),
      ),
      byStatus: Object.fromEntries(
        Object.entries(byStatus).map(([key, ms]) => [key, distribution(ms)]),
      ),
      steps: distribution(p.solverCalls.map((call) => call.steps)),
      componentSizes: distribution(p.solverCalls.map((call) => call.component)),
      candidateEntriesPerComponent: distribution(detail.solverCalls.map((call) => call.candidates)),
      candidateEntriesPerInput: distribution(
        detail.solverCalls.map((call) => call.inputCandidates),
      ),
      uniqueSolverInputs: hashes.size,
      exactAdjacentRepeats: exactRepeats,
      repeatedSolverMs: repeatedMs,
      byteLength: representative.bytes,
      jsonCharacters: p.jsonCharacters,
      cpu: p.cpu,
      gc: p.gc,
      memoryBefore: p.memoryBefore,
      memoryAfter: p.memoryAfter,
      detailHttpMs: scale.detail.ms,
    };
  });
  const output = path.join(path.dirname(file), 'summary.json');
  await fs.writeFile(output, JSON.stringify({ source: file, results: result }, null, 2));
  console.log(output);
}
summarize(
  path.resolve(process.argv[2] ?? 'outputs/backend-refactoring-stage-5-1/profile-final.json'),
).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
