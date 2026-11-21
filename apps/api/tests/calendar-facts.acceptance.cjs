const { test } = require('node:test');
const { runCalendarProfile, scales } = require('../scripts/calendar-performance.cjs');
test(
  'calendar matches frozen read model and preserves concurrent snapshots',
  { timeout: 180000 },
  async () => {
    await runCalendarProfile({
      label: 'regression',
      samples: 1,
      selected: [scales[0]],
      compare: true,
      compareBeforeLabels: true,
      metadataRegression: true,
      comparePreparation: true,
      preparationRegression: true,
    });
  },
);
