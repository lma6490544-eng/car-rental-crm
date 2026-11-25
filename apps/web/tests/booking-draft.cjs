const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadTypescript } = require('./helpers/load-typescript.cjs');
const { buildBookingDraft } = loadTypescript(
  path.resolve(__dirname, '../src/pages/booking-form/bookingDraft.ts'),
);
const { buildBookingCommand } = loadTypescript(
  path.resolve(__dirname, '../src/pages/booking-form/bookingCommand.ts'),
);
const values = {
  type: 'individual',
  details: { lastName: 'Иванов', firstName: 'Иван' },
  phone: '+7 (999) 123-45-67',
  start: '2026-11-18T12:00',
  days: 2,
  package: 250,
  vehicleId: 3,
};
const build = (changes = {}, initial, selecting = false, selected) =>
  buildBookingDraft({ ...values, ...changes }, false, undefined, selected, selecting, initial);

test('pricing preserves Moscow time, editing exclusion and integer basis points', () => {
  const result = build(
    { discountMode: 'percent', discount: '12,34', loyaltyReason: ' Акция ', freeDays: '2' },
    { bookingId: 8 },
  );
  assert.equal(result.draft.pricing.startAt, '2026-11-18T09:00:00.000Z');
  assert.deepEqual(result.draft.pricing.overrides, { discountBps: 1234, reason: 'Акция' });
  assert.deepEqual(result.draft.pricing.nonBillableDays, [{ dayIndex: 2, reason: 'Акция' }]);
  assert.equal(result.draft.bookingId, 8);
  assert.deepEqual(JSON.parse(result.scheduleKey), {
    target: { type: 'vehicle', id: 3 },
    startAt: '2026-11-18T09:00:00.000Z',
    endAt: '2026-11-20T09:00:00.000Z',
    bookingId: 8,
  });
});

test('contract terms use the assigned vehicle and omit the customer from the command', () => {
  const initial = { bookingId: 8, version: 3, target: 'brand:2', vehicleId: 7 };
  const form = { start: values.start, days: 2, package: 250 };
  const result = buildBookingDraft(form, false, undefined, undefined, false, initial, 'terms');
  const preview = {
    previewToken: 'current',
    availability: { status: 'feasible' },
    calculation: { overridesToConfirm: [] },
  };
  assert.deepEqual(result.target, { type: 'brand', id: 2 });
  assert.equal(result.draft.vehicleId, 7);
  const command = buildBookingCommand(
    form,
    undefined,
    preview,
    result.target,
    result.draft.pricing,
    false,
    initial,
    'terms',
  );
  assert.equal(command.vehicleId, 7);
  assert.equal(command.expectedVersion, 3);
  assert.equal('customer' in command, false);
});

test('invalid discounts and incomplete customer selection cannot produce a preview', () => {
  for (const discount of ['100.01', '-1', '1.234']) {
    assert.equal(build({ discountMode: 'percent', discount, loyaltyReason: 'Акция' }).draftKey, '');
  }
  assert.equal(build({}, undefined, true).draftKey, '');
  assert.equal(build({}, { customerId: 7 }).draftKey, '');
  assert.ok(build({}, { customerId: 7 }, false, { type: 'individual' }).draftKey);
  assert.ok(
    build({ phone: '' }).scheduleKey,
    'availability is independent of customer completeness',
  );
  assert.equal(build({ phone: '' }).draftKey, '');
});

test('zero overrides need a reason and invalid dates cannot form requests', () => {
  assert.equal(build({ custom: '0' }).draftKey, '');
  assert.deepEqual(
    build({ custom: '0', limit: 0, loyaltyReason: 'Подарок' }).draft.pricing.overrides,
    { customDailyRateRub: '0', mileageLimitKm: 0, reason: 'Подарок' },
  );
  assert.equal(build({ start: 'invalid' }).scheduleKey, '');
  assert.equal(build({ start: 'invalid' }).draftKey, '');
});

test('editing preserves customer version, booking version and risk acceptance token', () => {
  const preview = {
    previewToken: 'preview',
    availability: { status: 'unknown', token: 'risk' },
    calculation: { overridesToConfirm: ['customDailyRateRub'] },
  };
  const draft = build().draft;
  const command = buildBookingCommand(
    { ...values, unassignedReason: ' Причина ' },
    { id: 7, version: 9 },
    preview,
    draft.target,
    draft.pricing,
    true,
    { bookingId: 8, version: 12 },
  );
  assert.equal(command.expectedVersion, 12);
  assert.equal(command.customer.existingId, 7);
  assert.equal(command.customer.expectedVersion, 9);
  assert.equal(command.customer.data.displayName, 'Иванов Иван');
  assert.equal(command.previewToken, 'preview');
  assert.deepEqual(command.riskAcceptance, { token: 'risk', reason: 'Причина' });
  assert.deepEqual(command.confirmedOverrides, ['customDailyRateRub']);
  const create = buildBookingCommand(
    values,
    undefined,
    { ...preview, availability: { status: 'feasible' } },
    draft.target,
    draft.pricing,
    false,
  );
  assert.ok(create.customer.new);
  assert.equal('expectedVersion' in create, false);
  assert.equal('riskAcceptance' in create, false);
  assert.deepEqual(create.confirmedOverrides, []);
});
