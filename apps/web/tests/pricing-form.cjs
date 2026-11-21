const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadTypescript } = require('./helpers/load-typescript.cjs');
const { buildQuoteBody, baseFormValues } = loadTypescript(
  path.resolve(__dirname, '../src/pages/pricing/formData.ts'),
);
const values = {
  pricingGroupId: 2,
  startAt: '2026-11-18T12:00',
  contractDays: 3,
  dailyMileagePackageKm: 250,
  addedDays: 2,
  actualReturnAt: '2026-11-20T12:00',
  replacementAt: '2026-11-19T12:00',
};
const source = {
  id: 8,
  version: 4,
  input: { usages: [{ key: 'old', odometerOutKm: 10 }] },
  calculation: {
    contractDays: 3,
    startAt: '2026-11-18T09:00:00Z',
    agreedReturnAt: '2026-11-21T09:00:00Z',
    periods: [{ pricingGroup: { id: 2 } }],
    nonBillableDays: [{ dayIndex: 2, reason: 'Подарок' }],
    overrides: { customDailyRateRub: '0', discountBps: 1250, reason: 'Условия' },
  },
};

test('initial request preserves Moscow offset, zero overrides and usage numbering', () => {
  const result = buildQuoteBody(
    {
      ...values,
      manual: true,
      customDailyRateRub: '0',
      mileageLimitKm: 0,
      discountType: 'percent',
      discountValue: '0',
      reason: 'Подарок',
      usages: [{ key: 'old', odometerOutKm: 10 }],
      wash: true,
      manualSurcharge: true,
      surchargeRub: '0',
      surchargeReason: 'Без доплаты',
    },
    'initial',
    source,
  );
  assert.equal(result.startAt, '2026-11-18T12:00:00+03:00');
  assert.equal('baseQuoteId' in result, false);
  assert.deepEqual(result.overrides, {
    customDailyRateRub: '0',
    mileageLimitKm: 0,
    discountBps: 0,
    reason: 'Подарок',
  });
  assert.deepEqual(result.usages, [{ key: 'Автомобиль 1', odometerOutKm: 10 }]);
  assert.deepEqual(result.surchargeOverride, { amountRub: '0', reason: 'Без доплаты' });
  assert.equal(result.wash, true);
});

test('extension preserves agreed free days and rejects edits of the signed period', () => {
  const original = structuredClone(source);
  assert.deepEqual(
    buildQuoteBody(values, 'extension', source).nonBillableDays,
    source.calculation.nonBillableDays,
  );
  const extended = buildQuoteBody(
    { ...values, freeDays: '4, 5', freeReason: 'Новые' },
    'extension',
    source,
  );
  assert.deepEqual(extended.nonBillableDays, [
    ...source.calculation.nonBillableDays,
    { dayIndex: 4, reason: 'Новые' },
    { dayIndex: 5, reason: 'Новые' },
  ]);
  assert.equal(extended.baseQuoteId, 8);
  assert.equal(extended.expectedTermsVersion, 4);
  assert.equal(extended.addedDays, 2);
  assert.throws(
    () => buildQuoteBody({ ...values, freeDays: '2' }, 'extension', source),
    /только среди добавленных/,
  );
  assert.deepEqual(source, original);
});

test('unchanged free days retain source reasons; explicit removal remains explicit', () => {
  for (const operation of [
    'replacement',
    'early_return',
    'return',
    'non_billable_day',
    'adjustment',
  ]) {
    const body = buildQuoteBody({ ...values, freeDays: '2' }, operation, source);
    assert.equal('nonBillableDays' in body, false);
    assert.equal(body.expectedTermsVersion, 4);
    if (operation === 'replacement') assert.equal(body.replacementAt, '2026-11-19T12:00:00+03:00');
    if (['return', 'early_return'].includes(operation))
      assert.equal(body.actualReturnAt, '2026-11-20T12:00:00+03:00');
  }
  assert.deepEqual(buildQuoteBody(values, 'non_billable_day', source).nonBillableDays, []);
  assert.throws(() => buildQuoteBody({ ...values, freeDays: '1,,2' }, 'initial'), /целые числа/);
  assert.throws(
    () => buildQuoteBody({ ...values, freeDays: '1' }, 'initial'),
    /причину бесплатных/,
  );
  assert.throws(
    () => buildQuoteBody({ ...values, manual: true, reason: 'Пусто' }, 'initial'),
    /хотя бы одно/,
  );
  assert.equal(
    buildQuoteBody(
      { ...values, manual: true, clearOverrides: true, clearOverridesReason: 'По тарифу' },
      'adjustment',
      source,
    ).overrides,
    undefined,
  );
});

test('recalculation prefill keeps source immutable and isolates extension discounts', () => {
  const original = structuredClone(source);
  const extension = baseFormValues(source, 'extension');
  assert.equal(extension.freeDays, '');
  assert.equal(extension.discountValue, undefined);
  assert.equal(extension.actualReturnAt, '2026-11-21T12:00');
  assert.equal(extension.replacementAt, '2026-11-18T12:00');
  assert.deepEqual(extension.usages, [{ odometerOutKm: 10 }]);
  const adjustment = baseFormValues(source, 'adjustment');
  assert.equal(adjustment.freeDays, '2');
  assert.equal(adjustment.discountValue, '12.5');
  assert.equal(adjustment.customDailyRateRub, '0');
  assert.deepEqual(source, original);
});
