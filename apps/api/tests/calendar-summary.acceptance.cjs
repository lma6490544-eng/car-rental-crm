const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runCalendarProfile, scales } = require('../scripts/calendar-performance.cjs');

test(
  'calendar batches exact financial summaries and preserves concurrent financial snapshots',
  { timeout: 180000 },
  async () => {
    assert.equal(typeof require('../dist/finance/ledger').bookingSummaries, 'function');
    const [result] = await runCalendarProfile({
      label: 'finance-regression',
      samples: 1,
      selected: [scales[0]],
      compareBeforeSummary: true,
      financeProfile: true,
      financeRegression: true,
    });
    const run = result.runs[0];
    assert.equal(run.summaryTermsCalls, 1);
    assert.equal(run.summaryAllocationCalls, 1);
    assert.equal(run.summaryCreditCalls, 1);
  },
);
