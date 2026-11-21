const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { loadTypescript } = require('./helpers/load-typescript.cjs');
const filename = path.resolve(__dirname, '../src/shared/moscowTime.ts');
const {
  DAY_MS,
  moscowDate,
  moscowDateTimeInput,
  moscowDayStart,
  moscowMinuteToIso,
  withMoscowMinuteOffset,
} = loadTypescript(filename);

test('Moscow form values preserve midnight, year and leap-day boundaries', () => {
  for (const [instant, expected] of [
    ['2026-12-31T20:59:59.999Z', '2026-12-31T23:59'],
    ['2026-12-31T21:00:00.000Z', '2027-01-01T00:00'],
    ['2024-02-28T21:00:00.000Z', '2024-02-29T00:00'],
    ['2024-02-29T21:00:00.000Z', '2024-03-01T00:00'],
    ['2012-01-01T00:00:00.000Z', '2012-01-01T03:00'],
    ['2026-11-18T12:15:59+05:00', '2026-11-18T10:15'],
  ]) {
    assert.equal(moscowDateTimeInput(instant), expected);
    assert.equal(moscowDateTimeInput(Date.parse(instant)), expected);
    assert.equal(moscowDate(instant), expected.slice(0, 10));
    assert.equal(
      moscowMinuteToIso(expected),
      new Date(Math.floor(Date.parse(instant) / 60000) * 60000).toISOString(),
    );
  }
});

test('calendar midnight and rental-day arithmetic remain fixed at UTC+03:00', () => {
  assert.equal(new Date(moscowDayStart('2027-01-01')).toISOString(), '2026-12-31T21:00:00.000Z');
  assert.equal(moscowDayStart('2026-03-30') - moscowDayStart('2026-03-29'), DAY_MS);
  assert.equal(
    moscowDateTimeInput(moscowDayStart('2026-11-18') + 10 * 3600000),
    '2026-11-18T10:00',
  );
});

test('pricing pass-through and strict booking conversion retain different contracts', () => {
  assert.equal(withMoscowMinuteOffset('2026-11-18T12:00'), '2026-11-18T12:00:00+03:00');
  for (const value of ['', 'invalid', '2026-11-18T12:00:30+05:00', '2026-11-18T09:00:00Z'])
    assert.equal(withMoscowMinuteOffset(value), value);
  for (const value of ['', 'invalid', '2026-11-18T12:00:30+05:00'])
    assert.throws(() => moscowMinuteToIso(value), RangeError);
  assert.throws(() => moscowDate('invalid'), RangeError);
  assert.ok(Number.isNaN(moscowDayStart('invalid')));
});

test('fixed form offset does not inherit the execution machine timezone', () => {
  const loader = path.resolve(__dirname, 'helpers/load-typescript.cjs');
  const script = `const {loadTypescript}=require(${JSON.stringify(loader)}); const t=loadTypescript(${JSON.stringify(filename)}); process.stdout.write(JSON.stringify([t.moscowDateTimeInput('2026-12-31T21:00:00Z'),t.moscowMinuteToIso('2027-01-01T00:00')]));`;
  for (const timezone of ['UTC', 'America/New_York', 'Asia/Tokyo']) {
    assert.deepEqual(
      JSON.parse(
        execFileSync(process.execPath, ['-e', script], {
          env: { ...process.env, TZ: timezone },
          windowsHide: true,
          encoding: 'utf8',
        }),
      ),
      ['2027-01-01T00:00', '2026-12-31T21:00:00.000Z'],
    );
  }
});
