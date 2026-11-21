import { moscowMinuteToIso as iso, DAY_MS } from '../../shared/moscowTime';
import type { Customer } from '../../catalog';
import type { BookingOptions, Calculation } from '../../contracts';
import type { BookingFormValues, BookingInitial } from './types';
export const clean = (v: unknown) => String(v ?? '').trim();

export function buildBookingDraft(
  values: BookingFormValues,
  advanced: boolean,
  options: BookingOptions | undefined,
  selected: Customer | undefined,
  selecting: boolean,
  initial?: BookingInitial,
) {
  const type = selected?.type ?? values.type ?? 'individual';
  const target = advanced
    ? values.advancedTarget
      ? {
          type: String(values.advancedTarget).split(':')[0],
          id: Number(String(values.advancedTarget).split(':')[1]),
        }
      : undefined
    : values.vehicleId
      ? { type: 'vehicle', id: values.vehicleId }
      : values.modelId
        ? { type: 'model', id: values.modelId }
        : values.brandId
          ? { type: 'brand', id: values.brandId }
          : undefined;
  let scheduleKey = '';
  try {
    if (
      target &&
      values.start &&
      Number.isInteger(values.days) &&
      values.days > 0 &&
      values.days <= 3660
    )
      scheduleKey = JSON.stringify({
        target,
        startAt: iso(values.start),
        endAt: new Date(Date.parse(iso(values.start)) + values.days * DAY_MS).toISOString(),
        ...(initial?.bookingId ? { bookingId: initial.bookingId } : {}),
      });
  } catch {}
  const overrides: Omit<NonNullable<Calculation['overrides']>, 'reason'> = {};
  if (clean(values.custom) !== '') overrides.customDailyRateRub = clean(values.custom);
  if (values.limit !== undefined && values.limit !== null) overrides.mileageLimitKm = values.limit;
  let discountValid = true;
  if (clean(values.discount) !== '') {
    const value = clean(values.discount).replace(',', '.');
    if (values.discountMode === 'percent') {
      discountValid = /^(100(?:\.0{1,2})?|\d{1,2}(?:\.\d{1,2})?)$/.test(value);
      if (discountValid) {
        const [whole, fraction = ''] = value.split('.');
        overrides.discountBps = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
      }
    } else {
      discountValid = /^(0|[1-9]\d*)$/.test(value);
      if (discountValid) overrides.discountRub = value;
    }
  }
  const hasOverrides = Object.keys(overrides).length > 0,
    hasFree = !!clean(values.freeDays),
    loyalty = hasOverrides || hasFree;
  const requiresVehicle =
    !advanced &&
    !values.modelId &&
    new Set(
      (options?.models ?? [])
        .filter((m) => m.brandId === values.brandId)
        .map((m) => m.pricingGroupId),
    ).size > 1;
  const details = values.details ?? {},
    customerComplete =
      !!clean(values.phone) &&
      (type === 'company'
        ? !!clean(values.displayName)
        : !!clean(details.lastName) && !!clean(details.firstName));
  const phoneValid = /^(\+7|8)\d{10}$/.test(clean(values.phone).replace(/[\s()-]/g, ''));
  const complete =
    discountValid &&
    !!target &&
    (advanced || !requiresVehicle || !!values.vehicleId) &&
    !!values.start &&
    Number.isInteger(values.days) &&
    values.days > 0 &&
    values.days <= 3660 &&
    [100, 250, 400].includes(values.package) &&
    customerComplete &&
    phoneValid &&
    !selecting &&
    (!initial?.customerId || !!selected) &&
    (!loyalty || !!clean(values.loyaltyReason));
  let draft:
    | {
        target: { type: string; id: number } | undefined;
        pricing: {
          startAt: string;
          contractDays: number;
          dailyMileagePackageKm: number;
          overrides?: Calculation['overrides'];
          nonBillableDays?: { dayIndex: number; reason: string }[];
        };
        bookingId?: number;
      }
    | undefined;
  if (complete) {
    try {
      draft = {
        target,
        pricing: {
          startAt: iso(values.start),
          contractDays: values.days,
          dailyMileagePackageKm: values.package,
          ...(hasOverrides
            ? { overrides: { ...overrides, reason: clean(values.loyaltyReason) } }
            : {}),
          ...(hasFree
            ? {
                nonBillableDays: clean(values.freeDays)
                  .split(',')
                  .map((d) => ({
                    dayIndex: Number(d.trim()),
                    reason: clean(values.loyaltyReason),
                  })),
              }
            : {}),
        },
        ...(initial?.bookingId ? { bookingId: initial.bookingId } : {}),
      };
    } catch {
      draft = undefined;
    }
  }
  const draftKey = draft ? JSON.stringify(draft) : '';

  return { target, scheduleKey, draft, draftKey, discountValid, loyalty, requiresVehicle };
}
