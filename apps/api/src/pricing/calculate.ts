import { fail } from '../platform/security';
import { QuoteInput } from './pricing.dto';
import { Rules } from './rules';

const DAY = 86400000;
const iso = (n: number) => new Date(n).toISOString();
const sum = (values: string[]) => values.reduce((a, b) => a + BigInt(b), 0n);
const round = (n: bigint, d: bigint) => (n + d / 2n) / d;
const money = (n: bigint) => {
  if (n < 0n || n > 9223372036854775807n)
    fail(422, 'AMOUNT_RANGE', 'Итог выходит за диапазон целых рублей.');
  return n.toString();
};
type Group = { id: number; name: string; code: string };
type Discount = {
  fromDay: number;
  toDay: number;
  amountRub?: string;
  bps?: number;
  reason: string;
};
export type Period = {
  sequence: number;
  kind: 'initial' | 'extension' | 'replacement';
  groupSequence: number;
  groupStartDay: number;
  fromDay: number;
  toDay: number;
  startsAt: string;
  endsAt: string;
  pricingGroup: Group;
  tariffDurationDays: number;
  dailyRateRub: string;
  customDailyRateRub?: string;
  customPriceReason?: string;
  tariffSnapshot: Rules;
  sourcePeriodSequence?: number;
};
export type Calculation = {
  ruleVersion: string;
  operationKind: string;
  startAt: string;
  agreedReturnAt: string;
  contractDays: number;
  billableDays: number;
  dailyMileagePackageKm: 100 | 250 | 400;
  calculatedMileageLimitKm: number;
  effectiveMileageLimitKm: number;
  periods: Period[];
  dayLines: {
    dayIndex: number;
    startAt: string;
    endAt: string;
    baseRateRub: string;
    agreedDailyRateRub: string;
    nonBillable: boolean;
    reason?: string;
    exemptionRub: string;
    amountRub: string;
  }[];
  // Legacy total-price snapshots remain readable; new input only accepts daily price.
  overrides?: QuoteInput['overrides'] & { customTotalRub?: string; lateDailyRateRub?: string };
  nonBillableDays: {
    dayIndex: number;
    reason: string;
    authorId: number | null;
    markedAt: string;
  }[];
  discounts?: Discount[];
  pricingBasis?: Period;
  earlyReturn?: {
    originalReturnAt: string;
    actualReturnAt: string;
    fullDays: number;
    remainingFullHours: number;
  };
  refundOrCreditIfFullyPaidRub?: string;
  baseTotalRub: string;
  discountRub: string;
  finalAdjustmentRub: string;
  finalTotalRub: string;
  lateDailyRateRub: string;
  totalUsageMileageKm: number;
  lateSeconds: number;
  fullLateDays: number;
  remainingFullHours: number;
  lateCandidateRub: string;
  mileageCandidateRub: string;
  selectedSurchargeRub: string;
  confirmedSurchargeRub: string;
  surchargeOverride?: QuoteInput['surchargeOverride'];
  fuelCharges: {
    key: string;
    tankLiters: number;
    missingEighths: number;
    amountRub: string;
    outEighths: number;
    inEighths: number;
  }[];
  fuelTotalRub: string;
  washRub: string;
  totalWithExtrasRub: string;
  includedVatRub: string;
  old?: { finalTotalRub: string; effectiveMileageLimitKm: number; totalWithExtrasRub: string };
  differenceRub?: string;
  overridesToConfirm: string[];
  warnings: string[];
  explanation: string[];
  rulesSnapshot: Rules;
};
function rate(rules: Rules, group: Group, km: 100 | 250 | 400, days: number) {
  const g = rules.groups.find((g) => g.code === group.code);
  if (!g) fail(422, 'TARIFF_NOT_FOUND', 'Для группы нет ставки в выбранной версии прайса.');
  return g.rates[km][days === 1 ? 0 : g.category === 'minibus' || days < 8 ? 1 : 2];
}
export function calculate(
  input: QuoteInput,
  rules: Rules,
  group?: Group,
  base?: Calculation,
  actorId: number | null = null,
): Calculation {
  if (base?.contractDays === 0)
    fail(
      422,
      'EMPTY_TERM',
      'Для нового перерасчёта выберите исходный договор до досрочного возврата, а не расчёт без полных суток.',
    );
  const start = base ? Date.parse(base.startAt) : Date.parse(input.startAt!);
  let days = base?.contractDays ?? input.contractDays!;
  const km = base?.dailyMileagePackageKm ?? input.dailyMileagePackageKm!;
  let periods: Period[] = base ? structuredClone(base.periods) : [];
  let pricingBasis = base?.pricingBasis;
  if (
    base?.overrides &&
    (base.overrides.customTotalRub !== undefined ||
      base.overrides.lateDailyRateRub !== undefined) &&
    (input.operationKind !== 'adjustment' ||
      (!input.clearOverrides && input.overrides?.customDailyRateRub === undefined))
  )
    fail(
      422,
      'DAILY_PRICE_REQUIRED',
      'Исходный снимок содержит прежние ручные условия. Сначала создайте редакцию «Ручные условия» с ценой за сутки или явным возвратом к тарифу. Старый итог не преобразуется автоматически.',
    );
  let changedFromDay = 1;
  const warnings: string[] = [],
    explanation: string[] = [];
  const make = (
    from: number,
    to: number,
    kind: Period['kind'],
    g: Group,
    duration: number,
    groupSequence: number,
    groupStartDay: number,
  ): Period => ({
    sequence: periods.length + 1,
    kind,
    groupSequence,
    groupStartDay,
    fromDay: from,
    toDay: to,
    startsAt: iso(start + (from - 1) * DAY),
    endsAt: iso(start + to * DAY),
    pricingGroup: g,
    tariffDurationDays: duration,
    dailyRateRub: rate(rules, g, km, duration),
    tariffSnapshot: structuredClone(rules),
  });
  if (input.operationKind === 'initial') periods = [make(1, days, 'initial', group!, days, 1, 1)];
  if (input.operationKind === 'extension') {
    const previous = days;
    days += input.addedDays!;
    changedFromDay = previous + 1;
    if (days > 3660) fail(422, 'DURATION_RANGE', 'Общий срок не может превышать 3660 суток.');
    const last = periods.at(-1) ?? pricingBasis!;
    periods.push(
      make(
        previous + 1,
        days,
        'extension',
        last.pricingGroup,
        days,
        Math.max(0, ...periods.map((p) => p.groupSequence)) + 1,
        previous + 1,
      ),
    );
    explanation.push(
      `Первые ${previous} суток сохранены. Добавлено ${input.addedDays} суток; диапазон тарифа выбран по общему сроку ${days} суток и применяется только к добавлению.`,
    );
  }
  if (input.operationKind === 'early_return') {
    const elapsed = Date.parse(input.actualReturnAt!) - start;
    if (elapsed <= 0 || elapsed >= days * DAY)
      fail(
        422,
        'EARLY_RETURN_TIME',
        'Досрочный возврат должен быть после начала и раньше согласованного окончания.',
      );
    days = Math.floor(elapsed / DAY);
    const remainingSeconds = Math.floor((elapsed - days * DAY) / 1000);
    const basisDay = remainingSeconds > 0 ? days + 1 : days;
    const hoursPeriod = periods.find((p) => p.fromDay <= basisDay && p.toDay >= basisDay)!;
    const hoursDuration = Math.max(1, days - hoursPeriod.groupStartDay + 1);
    pricingBasis = {
      ...structuredClone(hoursPeriod),
      tariffDurationDays: hoursDuration,
      dailyRateRub: rate(hoursPeriod.tariffSnapshot, hoursPeriod.pricingGroup, km, hoursDuration),
    };
    const last = periods.find((p) => p.fromDay <= days && p.toDay >= days);
    const used = last ? days - last.groupStartDay + 1 : 0;
    changedFromDay = last?.groupStartDay ?? 1;
    // Preserve completed duration groups. Reprice all segments of the last used
    // group from their original rate snapshots, including replacement segments.
    periods = periods
      .filter((p) => p.fromDay <= days)
      .map((p) => {
        const next = { ...p, toDay: Math.min(p.toDay, days), sourcePeriodSequence: p.sequence };
        next.endsAt = iso(start + next.toDay * DAY);
        if (p.groupSequence === last!.groupSequence) {
          next.tariffDurationDays = used;
          next.dailyRateRub = rate(p.tariffSnapshot, p.pricingGroup, km, used);
        }
        return next;
      });
    explanation.push(
      `Использовано ${days} полных суток и ${Math.floor(remainingSeconds / 3600)} полных часов остатка. Полные сутки рассчитываются отдельно; остаток не округляется до новых суток. Из доплат за часы и перепробег выбирается одна большая сумма. Неиспользованные сутки исключены.`,
    );
  }
  if (input.operationKind === 'replacement') {
    const elapsed = Date.parse(input.replacementAt!) - start;
    if (elapsed < 0 || elapsed >= days * DAY)
      fail(422, 'REPLACEMENT_TIME', 'Замена должна находиться внутри договорного срока.');
    // At an exact boundary a new rental day has not begun yet.
    const first = Math.ceil(elapsed / DAY) + 1;
    changedFromDay = first;
    if (first <= days) {
      const retained = periods
        .filter((p) => p.fromDay < first)
        .map((p) => ({
          ...p,
          toDay: Math.min(p.toDay, first - 1),
          endsAt: iso(start + Math.min(p.toDay, first - 1) * DAY),
        }));
      // Only preview conditions from the change onward; preserve extension group boundaries.
      const changed = periods
        .filter((p) => p.toDay >= first)
        .map((p) => ({
          ...make(
            Math.max(p.fromDay, first),
            p.toDay,
            'replacement',
            group!,
            p.tariffDurationDays,
            p.groupSequence,
            p.groupStartDay,
          ),
          sourcePeriodSequence: p.sequence,
        }));
      periods = [...retained, ...changed];
      explanation.push(
        `Начавшиеся сутки остаются по прежней ставке. Новая группа действует с суток №${first}. Общий лимит не сбрасывается.`,
      );
    } else
      explanation.push(
        'До конца срока новых суток нет: начавшиеся сутки сохраняют прежнюю ставку.',
      );
  }
  periods = periods.map((p, i) => ({ ...p, sequence: i + 1 }));
  const requestedFree = input.nonBillableDays ?? base?.nonBillableDays ?? [];
  if (base && !['non_billable_day', 'adjustment'].includes(input.operationKind)) {
    const lockedThrough = Math.min(base.contractDays, days);
    const canonical = (items: { dayIndex: number; reason: string }[]) =>
      JSON.stringify(
        items
          .filter((d) => d.dayIndex <= lockedThrough)
          .map((d) => ({ dayIndex: d.dayIndex, reason: d.reason }))
          .sort((a, b) => a.dayIndex - b.dayIndex),
      );
    if (canonical(requestedFree) !== canonical(base.nonBillableDays))
      fail(
        422,
        'AGREED_DAYS_LOCKED',
        'Ранее согласованные «Вых» сохраняются. При продлении меняются только добавленные сутки. Для изменения прежних суток выберите «Изменить согласованные «Вых»».',
      );
  }
  if (input.nonBillableDays?.some((d) => d.dayIndex > days))
    fail(422, 'DAY_OUTSIDE_TERM', '«Вых» должен находиться внутри нового срока.');
  const free = requestedFree
    .filter((d) => d.dayIndex <= days)
    .map((d) => {
      const original = base?.nonBillableDays.find(
        (old) => old.dayIndex === d.dayIndex && old.reason === d.reason,
      );
      return original ?? { ...d, authorId: actorId, markedAt: new Date().toISOString() };
    });
  let overrides: Calculation['overrides'] = input.clearOverrides
    ? undefined
    : structuredClone(input.overrides ?? base?.overrides);
  if (input.operationKind === 'extension' && base) {
    // A discount from the signed period is not a new extension discount.
    if (overrides && !input.overrides) {
      const other = { ...overrides };
      delete other.discountRub;
      delete other.discountBps;
      overrides = other;
    }
    if (overrides?.mileageLimitKm === undefined && base.overrides?.mileageLimitKm !== undefined)
      overrides = {
        ...overrides,
        reason: overrides?.reason ?? base.overrides.reason,
        mileageLimitKm: base.overrides.mileageLimitKm,
      };
  }
  // Older snapshots stored one contract-wide discount. Preserve that exact
  // scope when extending them; new discounts have explicit day ranges.
  let discounts: Discount[] = structuredClone(
    base?.discounts ??
      (base &&
      (base.overrides?.discountRub !== undefined || base.overrides?.discountBps !== undefined)
        ? [
            {
              fromDay: 1,
              toDay: base.contractDays,
              amountRub: base.overrides.discountRub,
              bps: base.overrides.discountBps,
              reason: base.overrides.reason,
            },
          ]
        : []),
  );
  if (input.clearOverrides && input.operationKind !== 'extension') discounts = [];
  if (
    input.overrides?.discountRub !== undefined ||
    input.overrides?.discountBps !== undefined ||
    (!base && overrides)
  ) {
    const settings = input.overrides ?? overrides!;
    if (settings.discountRub !== undefined || settings.discountBps !== undefined) {
      const next = {
        fromDay: input.operationKind === 'extension' ? base!.contractDays + 1 : 1,
        toDay: days,
        amountRub: settings.discountRub,
        bps: settings.discountBps,
        reason: settings.reason,
      };
      discounts = input.operationKind === 'extension' ? [...discounts, next] : [next];
    }
  }
  discounts = discounts
    .filter((d) => d.fromDay <= days)
    .map((d) => ({ ...d, toDay: Math.min(d.toDay, days) }));
  // A new daily price changes only the new/recalculated portion. Completed
  // periods retain their agreed rates; each period carries its own price.
  const replacePrice =
    input.overrides !== undefined ||
    input.clearOverrides ||
    ['initial', 'extension', 'replacement'].includes(input.operationKind);
  if (replacePrice)
    periods = periods.map((p) => {
      if (p.toDay < changedFromDay) return p;
      const tariff = { ...p };
      delete tariff.customDailyRateRub;
      delete tariff.customPriceReason;
      return overrides?.customDailyRateRub !== undefined
        ? {
            ...tariff,
            customDailyRateRub: overrides.customDailyRateRub,
            customPriceReason: overrides.reason,
          }
        : tariff;
    });
  if (input.operationKind === 'early_return' && pricingBasis && replacePrice) {
    const tariff = { ...pricingBasis };
    delete tariff.customDailyRateRub;
    delete tariff.customPriceReason;
    pricingBasis =
      overrides?.customDailyRateRub !== undefined
        ? {
            ...tariff,
            customDailyRateRub: overrides.customDailyRateRub,
            customPriceReason: overrides.reason,
          }
        : tariff;
  }
  if (input.operationKind !== 'early_return') pricingBasis = periods.at(-1) ?? pricingBasis;
  if (overrides) {
    const other = { ...overrides };
    delete other.customDailyRateRub;
    delete other.customTotalRub;
    delete other.lateDailyRateRub;
    const last = pricingBasis!;
    overrides =
      last.customDailyRateRub !== undefined
        ? { ...other, customDailyRateRub: last.customDailyRateRub }
        : other;
  }
  if (input.clearOverrides)
    explanation.push(
      input.operationKind === 'extension'
        ? `Для добавленных суток выбраны тарифные условия без новой скидки. Прежние условия и индивидуальный лимит сохранены. Причина: ${input.clearOverridesReason}.`
        : `Ручные условия явно сброшены к тарифным. Причина: ${input.clearOverridesReason}.`,
    );
  const overridesToConfirm: string[] = [];
  if (
    periods.some((p) => p.customDailyRateRub !== undefined) ||
    pricingBasis?.customDailyRateRub !== undefined
  )
    overridesToConfirm.push('price');
  if (overrides?.mileageLimitKm !== undefined) overridesToConfirm.push('mileage');
  if (discounts.length) overridesToConfirm.push('discount');
  if (overridesToConfirm.length)
    warnings.push(
      'Ручные условия сохранены отдельно от расчётных. Подтвердите их для новой редакции; при необходимости измените значения с причиной.',
    );
  const dayLines = Array.from({ length: days }, (_, i) => {
    const dayIndex = i + 1,
      p = periods.find((p) => p.fromDay <= dayIndex && p.toDay >= dayIndex)!;
    const f = free.find((d) => d.dayIndex === dayIndex);
    const agreedDailyRateRub = p.customDailyRateRub ?? p.dailyRateRub;
    return {
      dayIndex,
      startAt: iso(start + i * DAY),
      endAt: iso(start + (i + 1) * DAY),
      baseRateRub: p.dailyRateRub,
      agreedDailyRateRub,
      nonBillable: !!f,
      ...(f ? { reason: f.reason } : {}),
      exemptionRub: f ? agreedDailyRateRub : '0',
      amountRub: f ? '0' : agreedDailyRateRub,
    };
  });
  const baseTotal = sum(dayLines.map((d) => d.amountRub));
  const discountAmounts = discounts.map((d) => {
    const gross = sum(
      dayLines
        .filter((line) => line.dayIndex >= d.fromDay && line.dayIndex <= d.toDay)
        .map((line) => line.amountRub),
    );
    const amount =
      d.amountRub !== undefined ? BigInt(d.amountRub) : round(gross * BigInt(d.bps ?? 0), 10000n);
    if (amount > gross)
      fail(422, 'DISCOUNT_TOO_LARGE', 'Скидка превышает стоимость суток, к которым она относится.');
    return amount;
  });
  const discount = discountAmounts.reduce((a, b) => a + b, 0n);
  if (input.operationKind === 'extension' && base) {
    const prefix = sum(
      dayLines.filter((d) => d.dayIndex <= base.contractDays).map((d) => d.amountRub),
    );
    const previousDiscount = discountAmounts
      .filter((_, i) => discounts[i].toDay <= base.contractDays)
      .reduce((a, b) => a + b, 0n);
    if (prefix - previousDiscount !== BigInt(base.finalTotalRub))
      fail(
        422,
        'AGREED_PRICE_LOCKED',
        'Продление не может менять стоимость согласованного периода. Измените прежние условия отдельной редакцией.',
      );
  }
  const calculated = baseTotal - discount,
    final = calculated;
  const mileageDays = Math.max(1, days);
  const calculatedMileageLimitKm = km * mileageDays;
  const limit = overrides?.mileageLimitKm ?? calculatedMileageLimitKm;
  const lastPeriod = pricingBasis!;
  const lateRate = lastPeriod.customDailyRateRub ?? lastPeriod.dailyRateRub;
  const agreed = start + days * DAY;
  if (input.operationKind === 'return' && Date.parse(input.actualReturnAt!) < agreed)
    fail(422, 'USE_EARLY_RETURN', 'Для возврата раньше срока выберите досрочный расчёт.');
  const seconds = input.actualReturnAt
    ? Math.max(0, Math.floor((Date.parse(input.actualReturnAt) - agreed) / 1000))
    : 0;
  const fullLateDays = Math.floor(seconds / 86400),
    hours = Math.floor((seconds % 86400) / 3600);
  const late =
    BigInt(fullLateDays) * BigInt(lateRate) +
    (hours >= 5 ? BigInt(lateRate) : BigInt(hours) * BigInt(rules.lateHourRub));
  const usageKm = (input.usages ?? []).reduce((n, u) => n + u.odometerInKm - u.odometerOutKm, 0);
  if (['return', 'early_return'].includes(input.operationKind) && !input.usages?.length)
    warnings.push(
      'Участки использования не указаны: перепробег и топливо пока рассчитаны без фактических показаний. Это неполный предварительный расчёт возврата.',
    );
  const mileage = BigInt(Math.max(0, usageKm - limit)) * BigInt(rules.excessKmRub),
    selected = late > mileage ? late : mileage;
  if (input.surchargeOverride) overridesToConfirm.push('surcharge');
  const surcharge = BigInt(input.surchargeOverride?.amountRub ?? selected);
  const fuelCharges = (input.usages ?? []).map((u) => {
    const tank = u.bodyType === 'cargo_minibus' ? 80 : 40,
      missing = Math.max(0, u.fuelOutEighths - u.fuelInEighths);
    return {
      key: u.key,
      tankLiters: tank,
      missingEighths: missing,
      outEighths: u.fuelOutEighths,
      inEighths: u.fuelInEighths,
      amountRub: money(BigInt((missing * tank) / 8) * BigInt(rules.fuelLiterRub)),
    };
  });
  const fuel = sum(fuelCharges.map((f) => f.amountRub)),
    wash = input.wash ? BigInt(rules.washRub) : 0n,
    total = final + surcharge + fuel + wash;
  explanation.push(
    days === 0
      ? `Полных суток ещё нет: сохраняется минимум один суточный пакет ${km} км. Это не добавляет оплачиваемые сутки к стоимости аренды.`
      : `Пакет ${km} км × ${days} договорных суток = ${calculatedMileageLimitKm} км. «Вых» не уменьшает срок, тарифный диапазон или лимит.`,
  );
  if (free.length)
    explanation.push(
      `Бесплатные сутки: ${free.map((d) => d.dayIndex).join(', ')}; стоимость этих суток — 0 ₽. Исходные ставки сохранены.`,
    );
  explanation.push(
    `${input.operationKind === 'early_return' ? 'Часы после полных суток' : 'Опоздание'}: ${fullLateDays} суток и ${hours} полных часов остатка → ${late} ₽. Перепробег: ${Math.max(0, usageKm - limit)} км → ${mileage} ₽. Выбрана одна большая сумма: ${selected} ₽.`,
  );
  for (const p of periods.filter((p) => p.customDailyRateRub !== undefined))
    explanation.push(
      `Сутки ${p.fromDay}–${p.toDay}: собственная цена ${p.customDailyRateRub} ₽/сутки, вместо тарифной ${p.dailyRateRub} ₽/сутки. Причина: ${p.customPriceReason}. «Вых» не оплачиваются.`,
    );
  discounts.forEach((d, i) =>
    explanation.push(
      `Скидка за сутки ${d.fromDay}–${d.toDay}: ${discountAmounts[i]} ₽. Причина: ${d.reason}.`,
    ),
  );
  explanation.push(
    `Стоимость дополнительных суток при опоздании — ${lateRate} ₽: согласованная цена последних суток, без отдельного ручного ввода. «Вых» эту ставку не обнуляет.`,
  );
  explanation.push(
    'Это предварительный расчёт. Подтверждение сохраняет снимок условий; бронь, выдача, начисления, платежи и выплаты не проводятся.',
  );
  const result: Calculation = {
    ruleVersion: rules.version,
    operationKind: input.operationKind,
    startAt: iso(start),
    agreedReturnAt: iso(agreed),
    contractDays: days,
    billableDays: days - free.length,
    dailyMileagePackageKm: km,
    calculatedMileageLimitKm,
    effectiveMileageLimitKm: limit,
    periods,
    dayLines,
    overrides,
    nonBillableDays: free,
    discounts,
    pricingBasis,
    baseTotalRub: money(baseTotal),
    discountRub: money(discount),
    finalAdjustmentRub: (final - calculated).toString(),
    finalTotalRub: money(final),
    lateDailyRateRub: lateRate,
    totalUsageMileageKm: usageKm,
    lateSeconds: seconds,
    fullLateDays,
    remainingFullHours: hours,
    lateCandidateRub: money(late),
    mileageCandidateRub: money(mileage),
    selectedSurchargeRub: money(selected),
    confirmedSurchargeRub: money(surcharge),
    surchargeOverride: input.surchargeOverride,
    fuelCharges,
    fuelTotalRub: money(fuel),
    washRub: money(wash),
    totalWithExtrasRub: money(total),
    includedVatRub: money(round(total * 5n, 105n)),
    overridesToConfirm,
    warnings,
    explanation,
    rulesSnapshot: structuredClone(rules),
  };
  if (base) {
    result.old = {
      finalTotalRub: base.finalTotalRub,
      effectiveMileageLimitKm: base.effectiveMileageLimitKm,
      totalWithExtrasRub: base.totalWithExtrasRub,
    };
    result.differenceRub = (total - BigInt(base.totalWithExtrasRub)).toString();
    if (input.operationKind === 'early_return') {
      result.earlyReturn = {
        originalReturnAt: base.agreedReturnAt,
        actualReturnAt: input.actualReturnAt!,
        fullDays: days,
        remainingFullHours: hours,
      };
      const reduction = BigInt(base.totalWithExtrasRub) - total;
      result.refundOrCreditIfFullyPaidRub = money(reduction > 0n ? reduction : 0n);
      explanation.push(
        `Уменьшение стоимости относительно прежнего итога: ${result.refundOrCreditIfFullyPaidRub} ₽. При полной оплате прежнего итога эта разница подлежит возврату или зачёту отдельной финансовой операцией. Без данных об оплате фактическая переплата не определяется.`,
      );
    }
  }
  return result;
}
