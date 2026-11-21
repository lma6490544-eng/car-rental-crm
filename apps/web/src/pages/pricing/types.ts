import type { Calculation } from '../../contracts';
export type Usage = {
  key?: string;
  odometerOutKm: number;
  odometerInKm: number;
  bodyType: string;
  fuelOutEighths: number;
  fuelInEighths: number;
};
export type QuoteBody = {
  operationKind: string;
  baseQuoteId?: number;
  expectedTermsVersion?: number;
  pricingGroupId?: number;
  startAt?: string;
  contractDays?: number;
  dailyMileagePackageKm?: number;
  addedDays?: number;
  actualReturnAt?: string;
  replacementAt?: string;
  nonBillableDays?: { dayIndex: number; reason: string }[];
  clearOverrides?: boolean;
  clearOverridesReason?: string;
  overrides?: Calculation['overrides'];
  usages?: Usage[];
  wash?: boolean;
  surchargeOverride?: Calculation['surchargeOverride'];
};
export type PricingFormValues = {
  pricingGroupId: number;
  startAt: string;
  contractDays: number;
  dailyMileagePackageKm: number;
  addedDays: number;
  actualReturnAt: string;
  replacementAt: string;
  freeDays?: string;
  freeReason?: string;
  clearOverrides?: boolean;
  clearOverridesReason?: string;
  manual?: boolean;
  customDailyRateRub?: string;
  mileageLimitKm?: number;
  reason: string;
  discountValue?: string;
  discountType?: string;
  usages?: Usage[];
  wash?: boolean;
  manualSurcharge?: boolean;
  surchargeRub: string;
  surchargeReason: string;
};

export type Quote = {
  id: number;
  version: number;
  confirmedAt: string | null;
  expiresAt: string;
  createdAt: string;
  baseQuoteId: number | null;
  calculation: Calculation;
  input: { usages?: Usage[] };
};
export type Catalog = { items: { id: number; name: string; code: string; category: string }[] };
export type History = {
  total: number;
  items: {
    id: number;
    version: number;
    confirmedAt: string | null;
    createdAt: string;
    finalTotalRub: string;
    operationKind: string;
    author: string;
  }[];
};
