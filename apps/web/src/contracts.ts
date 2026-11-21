// JSON response shapes consumed by the web app. Database rows use separate types.
import type { Customer } from './domain/catalog';
export type Calculation = {
  operationKind: string;
  ruleVersion: string;
  startAt: string;
  agreedReturnAt: string;
  contractDays: number;
  billableDays: number;
  dailyMileagePackageKm: number;
  calculatedMileageLimitKm: number;
  effectiveMileageLimitKm: number;
  baseTotalRub: string;
  discountRub: string;
  finalAdjustmentRub: string;
  finalTotalRub: string;
  lateDailyRateRub: string;
  lateCandidateRub: string;
  mileageCandidateRub: string;
  selectedSurchargeRub: string;
  confirmedSurchargeRub: string;
  fuelTotalRub: string;
  washRub: string;
  totalWithExtrasRub: string;
  includedVatRub: string;
  differenceRub?: string;
  old?: { finalTotalRub: string; effectiveMileageLimitKm: number; totalWithExtrasRub: string };
  earlyReturn?: {
    originalReturnAt: string;
    actualReturnAt: string;
    fullDays: number;
    remainingFullHours: number;
  };
  refundOrCreditIfFullyPaidRub?: string;
  overrides?: {
    customDailyRateRub?: string;
    customTotalRub?: string;
    lateDailyRateRub?: string;
    mileageLimitKm?: number;
    discountRub?: string;
    discountBps?: number;
    reason: string;
  };
  surchargeOverride?: { amountRub: string; reason: string };
  nonBillableDays: { dayIndex: number; reason: string }[];
  overridesToConfirm: string[];
  warnings: string[];
  explanation: string[];
  periods: {
    sequence: number;
    kind: string;
    groupStartDay: number;
    fromDay: number;
    toDay: number;
    tariffDurationDays: number;
    dailyRateRub: string;
    customDailyRateRub?: string;
    pricingGroup: { id: number; name: string };
    tariffSnapshot: { version: string };
  }[];
  dayLines: {
    dayIndex: number;
    startAt: string;
    endAt: string;
    baseRateRub: string;
    agreedDailyRateRub?: string;
    nonBillable: boolean;
    reason?: string;
    exemptionRub: string;
    amountRub: string;
  }[];
  fuelCharges: {
    key: string;
    tankLiters: number;
    outEighths: number;
    inEighths: number;
    amountRub: string;
  }[];
};

export type CommandResult = { id: number };
export type CustomerMatch = Pick<Customer, 'id' | 'type' | 'displayName' | 'phone' | 'isBlocked'>;
export type BookingVehicle = {
  id: number;
  modelId: number;
  brandId: number;
  modelName: string;
  plate: string;
  label: string;
  isReady: boolean;
  readinessReason: string;
};
export type BookingOptions = {
  vehicles: BookingVehicle[];
  models: { id: number; brandId: number; pricingGroupId: number; label: string }[];
  brands: { id: number; label: string }[];
  groups: { id: number; label: string }[];
};
export type Availability = {
  status: 'feasible' | 'deficit' | 'unknown';
  token: string;
};
export type ScheduleEvent = {
  id: number | string;
  vehicle_id: number | null;
  booking_id: number | null;
  kind: string;
  start_at: string;
  end_at: string;
  reason: string;
  customer_name?: string;
  customer_phone?: string;
  overlap_start?: string;
  overlap_end?: string;
  booking_version?: number;
  version?: number;
  financialSummary?: FinancialSummary;
};
export type TechnicalBlock = ScheduleEvent & { id: number; version: number };
export type Inspection = {
  availability: Availability;
  conflicts: ScheduleEvent[];
  alternatives: Omit<BookingVehicle, 'brandId'>[];
  problemReasons: string[];
  vehicle?: Omit<BookingVehicle, 'brandId'>;
  replacementReason?: string;
  targetLabel: string;
};
export type BookingPreview = Inspection & { calculation: Calculation; previewToken: string };
export type CalendarVehicle = {
  id: number;
  model_id: number;
  brand_name: string;
  model_name: string;
  pricing_group_name: string;
  plate: string;
  is_ready: boolean;
  readiness_reason: string;
  needs_wash: boolean;
  issue_notes: string;
  note: string;
  current_mileage_km: number | null;
  next_maintenance_due_km: number | null;
};
export type CalendarBooking = Omit<Inspection, 'alternatives'> & {
  id: number;
  version: number;
  start_at: string;
  end_at: string;
  vehicle_id: number | null;
  models: number[];
  customer_name: string;
  customer_phone: string;
};
export type BookingDetail = Inspection & {
  id: number;
  version: number;
  status: string;
  created_at: string;
  start_at: string;
  end_at: string;
  customer_id: number;
  customer_name: string;
  vehicle_id: number | null;
  target_type: string;
  target_vehicle_id: number | null;
  target_model_id: number | null;
  target_brand_id: number | null;
  target_group_id: number | null;
  terms: { snapshot: Calculation }[];
  vehicleOptions: { id: number; pricingGroupId: number; busy: boolean }[];
};
export type CalendarResponse = {
  vehicles: CalendarVehicle[];
  events: ScheduleEvent[];
  bookings: Pick<
    CalendarBooking,
    'id' | 'version' | 'start_at' | 'end_at' | 'vehicle_id' | 'models'
  >[];
  unassignedBookings: CalendarBooking[];
  problems: CalendarBooking[];
};
export type TechnicalPreview = { conflicts: TechnicalBlock[]; token: string };
export type MovePreview = Inspection & {
  vehicleId: number;
  startAt: string;
  endAt: string;
  expectedVersion: number;
  quoteToken?: string;
  blocked: boolean;
  oldStartAt: string;
  oldEndAt: string;
  oldVehicleId: number | null;
  vehiclePlate: string;
  oldPriceRub: string;
  priceRub: string;
};
export type CalendarPanel =
  | { kind: 'create'; vehicleId?: number; start?: string }
  | { kind: 'booking'; id: number; action?: 'assign' | 'edit' }
  | { kind: 'vehicle'; id: number }
  | { kind: 'problems' }
  | null;

export type FinancialSummary = {
  bookingId: number;
  customerId: number;
  bookingVersion: number;
  status: string;
  paymentsAllowed: boolean;
  priceRub: string;
  coverageRub: string;
  debtRub: string;
  overpaymentRub: string;
  depositRub: string;
  availableCreditRub: string;
  suggestedDepositRub: string | null;
  paidPercent: string;
};
export type FinancialOperation = {
  id: number;
  created_at: string;
  kind: string;
  reversal_of: number | null;
  reversedBy: number | null;
  reason: string;
  customer_id: number | null;
  customer_name: string | null;
  booking_id: number | null;
  author: string | null;
  chargeRub: string | null;
  external: { method: string; amountRub: string }[];
  funds: { fund: string; amountRub: string }[];
  allocations: { bucket: string; lotId: number; amountRub: string }[];
};
export type Fund = { id: string; balanceRub: string; initialized: boolean; hasEntries: boolean };
export type FinanceResponse = {
  items: Fund[];
  depositShortfallRub: string;
  initialAllowed: boolean;
  journal: { items: FinancialOperation[] };
};
export type ShortfallWarning = {
  token: string;
  negative: (Fund & { afterRub: string })[];
};
