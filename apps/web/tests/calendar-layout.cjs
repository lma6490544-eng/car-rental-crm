const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const Module = require('node:module');
const filename = path.resolve(__dirname, '../src/pages/calendar/calendar-layout.ts');
const loaded = new Module(filename, module);
loaded._compile(
  ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText,
  filename,
);
const { layoutCalendarEvents } = loaded.exports;
const event = (id, kind, start, end) => ({
  id,
  kind,
  booking_id: kind === 'technical' ? null : id,
  start_at: `2026-11-18T${start}:00+03:00`,
  end_at: `2026-11-18T${end}:00+03:00`,
});
test('adjacent half-open intervals share a lane and create no conflict', () => {
  const result = layoutCalendarEvents([
    event(1, 'assignment', '10:00', '11:00'),
    event(2, 'technical', '11:00', '12:00'),
  ]);
  assert.equal(result.lanes, 1);
  assert.deepEqual(result.conflicts, []);
});
test('repairs and displaced bookings preserve lanes and exact overlap', () => {
  const input = [
    event(3, 'displaced', '10:00', '12:00'),
    event(2, 'technical', '11:00', '13:00'),
    event(1, 'assignment', '10:00', '11:00'),
  ];
  const before = structuredClone(input);
  const result = layoutCalendarEvents(input);
  assert.deepEqual(input, before);
  assert.equal(result.lanes, 2);
  assert.deepEqual(
    result.events.map((e) => [e.id, e.lane]),
    [
      [1, 0],
      [2, 0],
      [3, 1],
    ],
  );
  assert.deepEqual(
    result.conflicts.map((c) => [c.start, c.end, c.bookingId]),
    [
      [Date.parse(input[0].start_at), Date.parse(input[2].end_at), 3],
      [Date.parse(input[1].start_at), Date.parse(input[0].end_at), 3],
    ],
  );
});
