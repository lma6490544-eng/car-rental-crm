import type { Calculation } from '../../contracts';
import type { QuoteBody, PricingFormValues, Quote, Usage } from './types';
import {
  moscowDateTimeInput as localTime,
  withMoscowMinuteOffset as at,
} from '../../shared/moscowTime';
export function buildQuoteBody(v: PricingFormValues, operation: string, base?: Quote): QuoteBody {
  const body: QuoteBody = {
    operationKind: operation,
    ...(base && operation !== 'initial'
      ? { baseQuoteId: base.id, expectedTermsVersion: base.version }
      : {}),
  };
  if (operation === 'initial')
    Object.assign(body, {
      pricingGroupId: v.pricingGroupId,
      startAt: at(v.startAt),
      contractDays: v.contractDays,
      dailyMileagePackageKm: v.dailyMileagePackageKm,
    });
  if (operation === 'extension') body.addedDays = v.addedDays;
  if (operation === 'replacement')
    Object.assign(body, {
      pricingGroupId: v.pricingGroupId,
      replacementAt: at(v.replacementAt),
    });
  if (operation === 'early_return' || operation === 'return')
    body.actualReturnAt = at(v.actualReturnAt);
  const raw = (v.freeDays ?? '').trim();
  if (raw && !/^\d+(\s*,\s*\d+)*$/.test(raw))
    throw new Error('Номера «Вых»: целые числа через запятую, например 1, 3.');
  // An untouched free-day list preserves individual reasons from the source.
  const original = base?.calculation.nonBillableDays ?? [];
  const indices: number[] = raw ? raw.split(',').map(Number) : [];
  if (
    operation === 'extension' &&
    base &&
    indices.some((day) => day <= base.calculation.contractDays)
  )
    throw new Error(
      'В продлении можно указать «Вых» только среди добавленных суток. Ранее согласованные сутки меняются отдельным действием.',
    );
  body.nonBillableDays = indices.map((dayIndex: number) => ({
    dayIndex,
    reason: v.freeReason || original.find((d) => d.dayIndex === dayIndex)?.reason || '',
  }));
  if (body.nonBillableDays.some((d) => !d.reason.trim()))
    throw new Error('Укажите причину бесплатных суток.');
  if (operation === 'extension')
    body.nonBillableDays = [
      ...original.map((d) => ({ dayIndex: d.dayIndex, reason: d.reason })),
      ...body.nonBillableDays,
    ];
  else if (base && !v.freeReason && indices.join(',') === original.map((d) => d.dayIndex).join(','))
    delete body.nonBillableDays;
  if (v.clearOverrides) {
    body.clearOverrides = true;
    body.clearOverridesReason = v.clearOverridesReason;
  }
  if (v.manual && !v.clearOverrides) {
    const o: NonNullable<Calculation['overrides']> = { reason: v.reason };
    for (const key of ['customDailyRateRub', 'mileageLimitKm'] as const)
      if (v[key] !== undefined && v[key] !== null && v[key] !== '')
        Object.assign(o, { [key]: v[key] });
    if (v.discountValue !== undefined && v.discountValue !== null && v.discountValue !== '') {
      if (v.discountType === 'percent') o.discountBps = Number(v.discountValue) * 100;
      else o.discountRub = v.discountValue;
    }
    if (Object.keys(o).length === 1) throw new Error('Введите хотя бы одно ручное условие.');
    body.overrides = o;
  }
  body.usages = (v.usages ?? []).map((u, i: number) => ({
    ...u,
    key: 'Автомобиль ' + (i + 1),
  }));
  body.wash = !!v.wash;
  if (v.manualSurcharge)
    body.surchargeOverride = { amountRub: v.surchargeRub, reason: v.surchargeReason };
  return body;
}
export function baseFormValues(quote: Quote, kind: string) {
  const c = quote.calculation;
  return {
    freeDays: kind === 'extension' ? '' : c.nonBillableDays.map((d) => d.dayIndex).join(', '),
    addedDays: 1,
    actualReturnAt: localTime(c.agreedReturnAt),
    replacementAt: localTime(c.startAt),
    pricingGroupId: c.periods.at(-1)?.pricingGroup.id,
    usages: quote.input.usages?.map(({ key: _key, ...u }: Usage) => u) ?? [],
    wash: false,
    ...c.overrides,
    discountType: c.overrides?.discountBps !== undefined ? 'percent' : 'rub',
    discountValue:
      kind === 'extension'
        ? undefined
        : c.overrides?.discountBps !== undefined
          ? String(c.overrides.discountBps / 100)
          : c.overrides?.discountRub,
  };
}
