const { test } = require('node:test');
const assert = require('node:assert/strict');
const { calculate } = require('../dist/pricing/calculate');
const { quoteInput } = require('../dist/pricing/pricing.dto');
const { ruleSets } = require('../dist/pricing/rules');
const rules = ruleSets[0],
  start = '2026-11-01T10:00:00+03:00';
const groups = ['economy', 'standard', 'comfort', 'berlingo', 'cargo'].map((code, i) => ({
  id: i + 1,
  code,
  name: code,
}));
const initial = (extra = {}, g = groups[0]) =>
  calculate(
    quoteInput.parse({
      operationKind: 'initial',
      pricingGroupId: g.id,
      startAt: start,
      contractDays: 3,
      dailyMileagePackageKm: 250,
      ...extra,
    }),
    rules,
    g,
  );
const change = (base, extra, g) =>
  calculate(
    quoteInput.parse({ baseQuoteId: 1, expectedTermsVersion: 2, ...extra }),
    rules,
    g,
    base,
    7,
  );
const after = (hours) => new Date(Date.parse(start) + hours * 3600000).toISOString();

test('all 45 source rate cells and duration boundaries', () => {
  const prices = [
    [
      [1900, 1600, 1500],
      [2000, 1700, 1600],
      [2200, 2000, 1800],
    ],
    [
      [2300, 2000, 1800],
      [2600, 2100, 1900],
      [2700, 2600, 2500],
    ],
    [
      [2700, 2500, 2100],
      [3000, 2850, 2700],
      [3250, 3000, 2900],
    ],
    [
      [2100, 2000, 2000],
      [2200, 2100, 2100],
      [2500, 2400, 2400],
    ],
    [
      [4400, 4000, 4000],
      [4600, 4100, 4100],
      [4900, 4900, 4900],
    ],
  ];
  for (let g = 0; g < 5; g++)
    for (let p = 0; p < 3; p++)
      for (const days of [1, 2, 7, 8, 30]) {
        const cell = days === 1 ? 0 : days < 8 ? 1 : 2;
        const result = initial(
          { dailyMileagePackageKm: [100, 250, 400][p], contractDays: days },
          groups[g],
        );
        assert.equal(result.finalTotalRub, String(prices[g][p][cell] * days), `${g}/${p}/${days}`);
      }
  assert.equal(initial().finalTotalRub, '5100');
  assert.equal(
    initial({ dailyMileagePackageKm: 100, contractDays: 8 }, groups[2]).finalTotalRub,
    '16800',
  );
  assert.equal(
    initial({ dailyMileagePackageKm: 400, contractDays: 8 }, groups[4]).finalTotalRub,
    '39200',
  );
});
test('free days preserve tariff duration, occupation, mileage and attribution', () => {
  const c = initial(
    { contractDays: 5, nonBillableDays: [{ dayIndex: 2, reason: 'Согласовано' }] },
    groups[1],
  );
  assert.equal(c.finalTotalRub, '8400');
  assert.equal(c.effectiveMileageLimitKm, 1250);
  assert.equal(c.billableDays, 4);
  assert.equal(c.dayLines[1].baseRateRub, '2100');
  const d = change(c, { operationKind: 'early_return', actualReturnAt: after(49) });
  assert.equal(d.contractDays, 2);
  assert.equal(d.nonBillableDays[0].markedAt, c.nonBillableDays[0].markedAt);
  const cut = change(c, { operationKind: 'early_return', actualReturnAt: after(23) });
  assert.equal(cut.nonBillableDays.length, 0);
  const zero = initial({
    contractDays: 1,
    nonBillableDays: [{ dayIndex: 1, reason: 'Бесплатно' }],
  });
  assert.equal(zero.finalTotalRub, '0');
  assert.equal(zero.lateDailyRateRub, '2000');
});
test('2 days 3 hours => 2 full days plus hours, 7+3 => 8 preserves original 7 and reprices one', () => {
  const partial = change(initial({ contractDays: 5 }), {
    operationKind: 'early_return',
    actualReturnAt: after(51),
  });
  assert.equal(partial.contractDays, 2);
  assert.equal(partial.finalTotalRub, '3400');
  assert.equal(partial.lateCandidateRub, '900');
  assert.equal(partial.totalWithExtrasRub, '4300');
  const seven = initial({ contractDays: 7 }),
    ten = change(seven, { operationKind: 'extension', addedDays: 3 });
  assert.equal(seven.finalTotalRub, '11900');
  assert.equal(ten.finalTotalRub, '16700');
  assert.equal(ten.periods[1].tariffDurationDays, 10);
  assert.equal(ten.periods[0].dailyRateRub, '1700');
  const eight = change(ten, { operationKind: 'early_return', actualReturnAt: after(8 * 24) });
  assert.equal(eight.finalTotalRub, '13900');
  assert.equal(eight.periods[0].toDay, 7);
  assert.equal(eight.periods[1].dailyRateRub, '2000');
  const before = change(ten, { operationKind: 'early_return', actualReturnAt: after(51) });
  assert.equal(before.periods.length, 1);
  assert.equal(before.finalTotalRub, '3400');
  assert.equal(before.totalWithExtrasRub, '4300');
  const fourteen = change(ten, { operationKind: 'extension', addedDays: 4 });
  const eleven = change(fourteen, {
    operationKind: 'early_return',
    actualReturnAt: after(11 * 24),
  });
  assert.equal(eleven.finalTotalRub, '18700');
});
test('replacement starts on next rental day, sums useages and preserves duration groups', () => {
  const base = initial({ contractDays: 5 });
  const swapped = change(
    base,
    { operationKind: 'replacement', replacementAt: after(36), pricingGroupId: 3 },
    groups[2],
  );
  assert.deepEqual(
    swapped.dayLines.map((d) => d.baseRateRub),
    ['1700', '1700', '2850', '2850', '2850'],
  );
  assert.equal(swapped.effectiveMileageLimitKm, 1250);
  const exact = change(
    base,
    { operationKind: 'replacement', replacementAt: after(24), pricingGroupId: 3 },
    groups[2],
  );
  assert.equal(exact.periods[1].fromDay, 2);
  const end = change(
    base,
    { operationKind: 'replacement', replacementAt: after(119), pricingGroupId: 3 },
    groups[2],
  );
  assert.equal(end.periods.length, 1);
  const early = change(swapped, { operationKind: 'early_return', actualReturnAt: after(51) });
  assert.equal(early.finalTotalRub, '3400');
  assert.equal(early.lateDailyRateRub, '2850');
  assert.equal(early.totalWithExtrasRub, '4300');
});
test('late hour boundaries, 26h = daily +600, MAX once, no automatic limit growth', () => {
  const base = initial({ contractDays: 1 });
  for (const [hours, expected] of [
    [59 / 60, 0],
    [119 / 60, 300],
    [299 / 60, 1200],
    [5, 2000],
    [23, 2000],
    [24, 2000],
    [26, 2600],
    [29, 4000],
    [48, 4000],
  ]) {
    const c = change(base, { operationKind: 'return', actualReturnAt: after(24 + hours) });
    assert.equal(c.lateCandidateRub, String(expected));
    assert.equal(c.effectiveMileageLimitKm, 250);
  }
  const usage = {
    key: 'one',
    odometerOutKm: 1000,
    odometerInKm: 1650,
    bodyType: 'sedan',
    fuelOutEighths: 8,
    fuelInEighths: 8,
  };
  const max = change(base, { operationKind: 'return', actualReturnAt: after(50), usages: [usage] });
  assert.equal(max.lateCandidateRub, '2600');
  assert.equal(max.mileageCandidateRub, '2800');
  assert.equal(max.selectedSurchargeRub, '2800');
  const equal = change(base, { operationKind: 'return', actualReturnAt: after(24), usages: [] });
  assert.equal(equal.selectedSurchargeRub, '0');
});
test('fuel by each usage, 40/80L, surplus zero, mileage across cars, wash separate', () => {
  const usage = (key, bodyType, fuelInEighths, odometerOutKm, odometerInKm) => ({
    key,
    bodyType,
    fuelOutEighths: 8,
    fuelInEighths,
    odometerOutKm,
    odometerInKm,
  });
  const c = initial({
    contractDays: 1,
    usages: [usage('a', 'compact_van', 7, 90000, 90100), usage('b', 'cargo_minibus', 7, 100, 300)],
    wash: true,
  });
  assert.equal(c.totalUsageMileageKm, 300);
  assert.equal(c.fuelCharges[0].amountRub, '400');
  assert.equal(c.fuelCharges[1].amountRub, '800');
  assert.equal(c.fuelTotalRub, '1200');
  assert.equal(c.washRub, '1000');
  assert.equal(c.selectedSurchargeRub, '350');
  assert.equal(
    initial({ usages: [{ ...usage('x', 'sedan', 8, 0, 0), fuelOutEighths: 7 }] }).fuelTotalRub,
    '0',
  );
});
test('manual zeros survive recalculation and require explicit confirmations', () => {
  const base = initial({
    overrides: { customDailyRateRub: '0', mileageLimitKm: 0, reason: 'Согласовано' },
  });
  assert.equal(base.finalTotalRub, '0');
  assert.equal(base.lateDailyRateRub, '0');
  assert.equal(base.effectiveMileageLimitKm, 0);
  const next = change(base, { operationKind: 'extension', addedDays: 2 });
  assert.equal(next.finalTotalRub, '0');
  assert.equal(next.effectiveMileageLimitKm, 0);
  assert.deepEqual(next.overridesToConfirm, ['price', 'mileage']);
  const reset = change(base, {
    operationKind: 'adjustment',
    clearOverrides: true,
    clearOverridesReason: 'Возврат к прайсу',
  });
  assert.equal(reset.finalTotalRub, '5100');
  assert.equal(reset.effectiveMileageLimitKm, 750);
  const manual = initial({ surchargeOverride: { amountRub: '0', reason: 'Согласовано' } });
  assert.equal(manual.confirmedSurchargeRub, '0');
  assert.deepEqual(manual.overridesToConfirm, ['surcharge']);
});
test('integer precision, half-up discounts and included VAT', () => {
  const c = initial({ overrides: { customDailyRateRub: '10000', reason: 'Цена' } });
  assert.equal(c.includedVatRub, '1429');
  assert.equal(
    initial({
      contractDays: 1,
      overrides: { customDailyRateRub: '9007199254740993', reason: 'Большая цена' },
    }).finalTotalRub,
    '9007199254740993',
  );
  const d = initial(
    { contractDays: 2, overrides: { discountBps: 1, reason: 'Скидка' } },
    groups[2],
  );
  assert.equal(d.discountRub, '1');
  assert.throws(() => initial({ overrides: { discountRub: '999999', reason: 'Нет' } }));
  assert.throws(() =>
    initial({
      overrides: { customDailyRateRub: '9223372036854775807', reason: 'Цена' },
      wash: true,
    }),
  );
});
test('strict invalid inputs, boundary ranges and illegal operation fields', () => {
  for (const extra of [
    { contractDays: 0 },
    { contractDays: 1.5 },
    { dailyMileagePackageKm: 200 },
    { overrides: { customDailyRateRub: '1.5', reason: 'Нет' } },
    { overrides: { customTotalRub: '0', reason: 'Нет' } },
    { overrides: { customDailyRateRub: '0', lateDailyRateRub: '0', reason: 'Нет' } },
    { overrides: { discountRub: '1', discountBps: 100, reason: 'Нет' } },
    {
      nonBillableDays: [
        { dayIndex: 1, reason: 'a' },
        { dayIndex: 1, reason: 'b' },
      ],
    },
  ])
    assert.throws(() =>
      quoteInput.parse({
        operationKind: 'initial',
        pricingGroupId: 1,
        startAt: start,
        contractDays: 3,
        dailyMileagePackageKm: 250,
        ...extra,
      }),
    );
  assert.throws(() => initial({ nonBillableDays: [{ dayIndex: 4, reason: 'Нет' }] }));
  assert.throws(() =>
    change(initial(), { operationKind: 'extension', addedDays: 1, contractDays: 4 }),
  );
  assert.throws(() =>
    change(initial(), { operationKind: 'early_return', actualReturnAt: after(0) }),
  );
  assert.throws(() => change(initial(), { operationKind: 'return', actualReturnAt: after(12) }));
  const u = {
    key: 'a',
    odometerOutKm: 5,
    odometerInKm: 4,
    bodyType: 'sedan',
    fuelOutEighths: 8,
    fuelInEighths: 7,
  };
  assert.throws(() => initial({ usages: [u] }));
  assert.throws(() => initial({ usages: [{ ...u, odometerInKm: 10, fuelInEighths: 9 }] }));
});

test('custom daily price multiplies paid days, free days and late rate use the agreed price', () => {
  const base = initial({
    contractDays: 5,
    overrides: { customDailyRateRub: '1200', reason: 'Индивидуальная ставка' },
  });
  assert.equal(base.finalTotalRub, '6000');
  assert.equal(base.lateDailyRateRub, '1200');
  const free = change(base, {
    operationKind: 'non_billable_day',
    nonBillableDays: [{ dayIndex: 2, reason: 'Вых' }],
  });
  assert.equal(free.finalTotalRub, '4800');
  assert.equal(free.effectiveMileageLimitKm, 1250);
  assert.equal(free.dayLines[1].exemptionRub, '1200');
  const late = change(free, { operationKind: 'return', actualReturnAt: after(5 * 24 + 26) });
  assert.equal(late.lateCandidateRub, '1800');
  const discount = initial({
    contractDays: 3,
    overrides: { customDailyRateRub: '1200', discountBps: 1000, reason: 'Цена и скидка' },
  });
  assert.equal(discount.finalTotalRub, '3240');
  assert.equal(discount.lateDailyRateRub, '1200');
});
test('different custom daily prices preserve previous periods on extension, replacement and early return', () => {
  const seven = initial({
    contractDays: 7,
    overrides: { customDailyRateRub: '1200', reason: 'Первый период' },
  });
  const ten = change(seven, {
    operationKind: 'extension',
    addedDays: 3,
    overrides: { customDailyRateRub: '2000', reason: 'Продление' },
  });
  assert.equal(ten.finalTotalRub, '14400');
  assert.equal(ten.periods[0].customDailyRateRub, '1200');
  assert.equal(ten.periods[1].customDailyRateRub, '2000');
  const eight = change(ten, { operationKind: 'early_return', actualReturnAt: after(8 * 24) });
  assert.equal(eight.finalTotalRub, '10400');
  assert.equal(eight.lateDailyRateRub, '2000');
  const before = change(ten, { operationKind: 'early_return', actualReturnAt: after(51) });
  assert.equal(before.finalTotalRub, '2400');
  assert.equal(before.totalWithExtrasRub, '3300');
  assert.equal(before.overrides.customDailyRateRub, '1200');
  assert.equal(before.lateDailyRateRub, '1200');
  const swap = change(
    seven,
    {
      operationKind: 'replacement',
      replacementAt: after(36),
      pricingGroupId: 5,
      overrides: { customDailyRateRub: '4000', reason: 'Новая машина' },
    },
    groups[4],
  );
  assert.equal(swap.finalTotalRub, '22400');
  assert.equal(swap.dayLines[0].amountRub, '1200');
  assert.equal(swap.dayLines[2].amountRub, '4000');
  const tariff = change(ten, {
    operationKind: 'extension',
    addedDays: 1,
    clearOverrides: true,
    clearOverridesReason: 'Дальше по тарифу',
  });
  assert.equal(tariff.finalTotalRub, '16000');
  assert.equal(tariff.periods[0].customDailyRateRub, '1200');
  assert.equal(tariff.periods[1].customDailyRateRub, '2000');
});
test('legacy total-price snapshots are never reinterpreted as daily prices', () => {
  const legacy = initial();
  legacy.overrides = {
    customTotalRub: '1200',
    lateDailyRateRub: '2000',
    reason: 'Прежний общий итог',
  };
  legacy.finalTotalRub = '1200';
  const original = structuredClone(legacy);
  assert.throws(
    () => change(legacy, { operationKind: 'extension', addedDays: 1 }),
    (e) => e.getResponse().code === 'DAILY_PRICE_REQUIRED',
  );
  const updated = change(legacy, {
    operationKind: 'adjustment',
    overrides: { customDailyRateRub: '1200', reason: 'Цена за сутки' },
  });
  assert.equal(updated.finalTotalRub, '3600');
  assert.deepEqual(legacy, original);
});

test('extension preserves agreed free days, prices and attribution; editing old days is a separate action', () => {
  const base = initial({
    contractDays: 4,
    nonBillableDays: [{ dayIndex: 2, reason: 'Подарили' }],
    overrides: { customDailyRateRub: '1200', reason: 'Согласованная цена' },
  });
  const original = structuredClone(base);
  const extended = change(base, { operationKind: 'extension', addedDays: 7 });
  assert.equal(base.finalTotalRub, '3600');
  assert.equal(extended.finalTotalRub, '12000');
  assert.deepEqual(extended.dayLines.slice(0, 4), base.dayLines);
  assert.deepEqual(extended.nonBillableDays, base.nonBillableDays);
  assert.deepEqual(base, original);
  for (const nonBillableDays of [
    [],
    [{ dayIndex: 2, reason: 'Другая причина' }],
    [
      { dayIndex: 2, reason: 'Подарили' },
      { dayIndex: 3, reason: 'Новый' },
    ],
  ]) {
    assert.throws(
      () => change(base, { operationKind: 'extension', addedDays: 7, nonBillableDays }),
      (e) => e.getResponse().code === 'AGREED_DAYS_LOCKED',
    );
  }
  const withNew = change(base, {
    operationKind: 'extension',
    addedDays: 7,
    nonBillableDays: [
      { dayIndex: 2, reason: 'Подарили' },
      { dayIndex: 5, reason: 'Вых продления' },
    ],
  });
  assert.equal(withNew.finalTotalRub, '10800');
  assert.deepEqual(withNew.dayLines.slice(0, 4), base.dayLines);
  const explicit = change(base, { operationKind: 'non_billable_day', nonBillableDays: [] });
  assert.equal(explicit.finalTotalRub, '4800');
  assert.equal(base.dayLines[1].amountRub, '0');
});

test('extension discounts affect only added days and preserve the agreed original total', () => {
  for (const settings of [{ discountRub: '500' }, { discountBps: 1000 }]) {
    const base = initial({
      contractDays: 4,
      nonBillableDays: [{ dayIndex: 2, reason: 'Подарили' }],
      overrides: {
        customDailyRateRub: '1200',
        mileageLimitKm: 0,
        ...settings,
        reason: 'Цена и скидка',
      },
    });
    // Backward compatibility with a saved v2 snapshot, which had one global discount.
    const legacy = structuredClone(base);
    delete legacy.discounts;
    const extended = change(legacy, { operationKind: 'extension', addedDays: 7 });
    assert.equal(BigInt(extended.finalTotalRub) - BigInt(base.finalTotalRub), 8400n);
    assert.equal(extended.discountRub, base.discountRub);
    const next = change(legacy, {
      operationKind: 'extension',
      addedDays: 7,
      overrides: { customDailyRateRub: '2000', discountRub: '800', reason: 'Только продление' },
    });
    assert.equal(BigInt(next.finalTotalRub) - BigInt(base.finalTotalRub), 13200n);
    assert.equal(next.effectiveMileageLimitKm, 0);
    assert.deepEqual(next.dayLines.slice(0, 4), base.dayLines);
    const again = change(next, { operationKind: 'extension', addedDays: 1 });
    assert.equal(BigInt(again.finalTotalRub) - BigInt(next.finalTotalRub), 2000n);
    const early = change(next, { operationKind: 'early_return', actualReturnAt: after(5 * 24) });
    assert.equal(BigInt(early.finalTotalRub) - BigInt(base.finalTotalRub), 1200n);
    const tariff = change(legacy, {
      operationKind: 'extension',
      addedDays: 7,
      clearOverrides: true,
      clearOverridesReason: 'Добавленные сутки по прайсу',
    });
    assert.equal(BigInt(tariff.finalTotalRub) - BigInt(base.finalTotalRub), 11200n);
    assert.equal(tariff.effectiveMileageLimitKm, 0);
  }
});

test('early return: 6 full days +3 hours =8100, MAX mileage and refund/credit reduction', () => {
  const base = initial({
      contractDays: 11,
      overrides: { customDailyRateRub: '1200', reason: 'Согласовано' },
    }),
    original = structuredClone(base);
  const early = change(base, { operationKind: 'early_return', actualReturnAt: after(6 * 24 + 3) });
  assert.equal(early.contractDays, 6);
  assert.equal(early.billableDays, 6);
  assert.equal(early.finalTotalRub, '7200');
  assert.equal(early.lateCandidateRub, '900');
  assert.equal(early.totalWithExtrasRub, '8100');
  assert.equal(early.refundOrCreditIfFullyPaidRub, '5100');
  assert.equal(early.effectiveMileageLimitKm, 1500);
  assert.equal(early.earlyReturn.remainingFullHours, 3);
  assert.deepEqual(base, original);
  const usage = {
    key: 'one',
    bodyType: 'sedan',
    odometerOutKm: 1000,
    odometerInKm: 2700,
    fuelOutEighths: 8,
    fuelInEighths: 8,
  };
  const mileage = change(base, {
    operationKind: 'early_return',
    actualReturnAt: after(147),
    usages: [usage],
  });
  assert.equal(mileage.mileageCandidateRub, '1400');
  assert.equal(mileage.selectedSurchargeRub, '1400');
  assert.equal(mileage.totalWithExtrasRub, '8600');
  assert.equal(mileage.refundOrCreditIfFullyPaidRub, '4600');
  const extras = change(base, {
    operationKind: 'early_return',
    actualReturnAt: after(147),
    usages: [{ ...usage, odometerInKm: 2400, fuelInEighths: 7 }],
    wash: true,
  });
  assert.equal(extras.totalWithExtrasRub, '9500');
});

test('early hours boundaries, zero full days, manual zero and exact day boundaries', () => {
  const base = initial({
    contractDays: 5,
    overrides: { customDailyRateRub: '1200', reason: 'Цена' },
  });
  for (const [hours, expected] of [
    [59 / 60, '0'],
    [119 / 60, '300'],
    [299 / 60, '1200'],
    [5, '1200'],
    [23, '1200'],
  ]) {
    const c = change(base, { operationKind: 'early_return', actualReturnAt: after(hours) });
    assert.equal(c.contractDays, 0);
    assert.equal(c.finalTotalRub, '0');
    assert.equal(c.lateCandidateRub, expected);
    assert.equal(c.totalWithExtrasRub, expected);
    assert.equal(c.periods.length, 0);
  }
  const exact = change(base, { operationKind: 'early_return', actualReturnAt: after(48) });
  assert.equal(exact.totalWithExtrasRub, '2400');
  assert.equal(exact.lateCandidateRub, '0');
  const zero = initial({
    contractDays: 5,
    overrides: { customDailyRateRub: '0', mileageLimitKm: 0, reason: 'Бесплатно' },
  });
  assert.equal(
    change(zero, { operationKind: 'early_return', actualReturnAt: after(53) }).totalWithExtrasRub,
    '0',
  );
  assert.equal(
    change(zero, { operationKind: 'early_return', actualReturnAt: after(51) }).totalWithExtrasRub,
    '900',
  );
});

test('early partial extension and replacement use the current period for hourly daily-rate cap', () => {
  const seven = initial({
    contractDays: 7,
    overrides: { customDailyRateRub: '1200', reason: 'Первый период' },
  });
  const ten = change(seven, {
    operationKind: 'extension',
    addedDays: 3,
    overrides: { customDailyRateRub: '2000', reason: 'Продление' },
  });
  const c = change(ten, { operationKind: 'early_return', actualReturnAt: after(7 * 24 + 5) });
  assert.equal(c.finalTotalRub, '8400');
  assert.equal(c.lateDailyRateRub, '2000');
  assert.equal(c.lateCandidateRub, '2000');
  assert.equal(c.totalWithExtrasRub, '10400');
  assert.equal(c.periods.length, 1);
  const free = initial({
    contractDays: 11,
    nonBillableDays: [
      { dayIndex: 2, reason: 'Подарили' },
      { dayIndex: 7, reason: 'Будущий Вых' },
    ],
    overrides: { customDailyRateRub: '1200', discountBps: 1000, reason: 'Цена и скидка' },
  });
  const cut = change(free, { operationKind: 'early_return', actualReturnAt: after(147) });
  assert.equal(cut.contractDays, 6);
  assert.equal(cut.billableDays, 5);
  assert.equal(cut.finalTotalRub, '5400');
  assert.equal(cut.totalWithExtrasRub, '6300');
  assert.equal(cut.nonBillableDays.length, 1);
});

test('early return below 24h keeps one mileage package, respects exact limits and explicit overrides', () => {
  const usage = (km) => ({
    key: 'one',
    bodyType: 'sedan',
    odometerOutKm: 1000,
    odometerInKm: 1000 + km,
    fuelOutEighths: 8,
    fuelInEighths: 8,
  });
  for (const km of [100, 250, 400]) {
    const base = initial({ contractDays: 5, dailyMileagePackageKm: km }),
      original = structuredClone(base);
    for (const hours of [1, 5, 23 + 59 / 60, 24, 25]) {
      const c = change(base, {
        operationKind: 'early_return',
        actualReturnAt: after(hours),
        usages: [usage(km)],
      });
      assert.equal(c.calculatedMileageLimitKm, km);
      assert.equal(c.effectiveMileageLimitKm, km);
      assert.equal(c.mileageCandidateRub, '0');
    }
    const boundary = change(base, {
      operationKind: 'early_return',
      actualReturnAt: after(23),
      usages: [usage(km + 1)],
    });
    assert.equal(boundary.mileageCandidateRub, '7');
    assert.equal(boundary.contractDays, 0);
    assert.equal(boundary.finalTotalRub, '0');
    const two = change(base, {
      operationKind: 'early_return',
      actualReturnAt: after(48),
      usages: [usage(2 * km)],
    });
    assert.equal(two.calculatedMileageLimitKm, 2 * km);
    assert.equal(two.mileageCandidateRub, '0');
    assert.deepEqual(base, original);
  }
  const zero = initial({ overrides: { mileageLimitKm: 0, reason: 'Нулевой лимит' } }),
    custom = initial({ overrides: { mileageLimitKm: 500, reason: 'Лимит клиента' } });
  const a = change(zero, {
    operationKind: 'early_return',
    actualReturnAt: after(3),
    usages: [usage(150)],
  });
  assert.equal(a.calculatedMileageLimitKm, 250);
  assert.equal(a.effectiveMileageLimitKm, 0);
  assert.equal(a.mileageCandidateRub, '1050');
  assert.equal(a.selectedSurchargeRub, '1050');
  const b = change(custom, {
    operationKind: 'early_return',
    actualReturnAt: after(3),
    usages: [usage(500)],
  });
  assert.equal(b.effectiveMileageLimitKm, 500);
  assert.equal(b.mileageCandidateRub, '0');
  assert.ok(b.overridesToConfirm.includes('mileage'));
});
