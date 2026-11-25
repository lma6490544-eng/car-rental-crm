import { z } from 'zod';
const rubPattern = /^(0|[1-9]\d{0,18})$/;
export const rub = z
  .string()
  .regex(rubPattern)
  .refine((v) => !rubPattern.test(v) || BigInt(v) <= 9223372036854775807n, 'Сумма слишком велика.');
const reason = z.string().trim().min(1).max(1000);
const id = z.number().int().positive().max(2147483647);
const days = z.number().int().min(1).max(3660);
const overrides = z
  .object({
    customDailyRateRub: rub.optional(),
    mileageLimitKm: z.number().int().min(0).max(2147483647).optional(),
    discountRub: rub.optional(),
    discountBps: z.number().int().min(0).max(10000).optional(),
    reason,
  })
  .strict()
  .refine((v) => Object.keys(v).length > 1, 'Введите хотя бы одно ручное условие.')
  .refine(
    (v) => v.discountRub === undefined || v.discountBps === undefined,
    'Выберите один вид скидки.',
  );
export const quoteInput = z
  .object({
    operationKind: z.enum([
      'initial',
      'extension',
      'early_return',
      'replacement',
      'non_billable_day',
      'adjustment',
      'return',
    ]),
    baseQuoteId: id.optional(),
    expectedTermsVersion: z.number().int().positive().optional(),
    pricingGroupId: id.optional(),
    startAt: z.iso.datetime({ offset: true }).optional(),
    contractDays: days.optional(),
    dailyMileagePackageKm: z.union([z.literal(100), z.literal(250), z.literal(400)]).optional(),
    addedDays: days.optional(),
    actualReturnAt: z.iso.datetime({ offset: true }).optional(),
    replacementAt: z.iso.datetime({ offset: true }).optional(),
    nonBillableDays: z
      .array(z.object({ dayIndex: days, reason }).strict())
      .max(3660)
      .optional(),
    overrides: overrides.optional(),
    clearOverrides: z.boolean().default(false),
    clearOverridesReason: reason.optional(),
    usages: z
      .array(
        z
          .object({
            key: z.string().trim().min(1).max(80),
            odometerOutKm: z.number().int().min(0).max(2147483647),
            odometerInKm: z.number().int().min(0).max(2147483647),
            bodyType: z.enum(['sedan', 'hatchback', 'compact_van', 'cargo_minibus']),
            fuelOutEighths: z.number().int().min(0).max(8),
            fuelInEighths: z.number().int().min(0).max(8),
          })
          .strict()
          .refine(
            (v) => v.odometerInKm >= v.odometerOutKm,
            'Пробег при возврате меньше выдачного.',
          ),
      )
      .max(100)
      .optional(),
    wash: z.boolean().default(false),
    surchargeOverride: z.object({ amountRub: rub, reason }).strict().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const error = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (v.operationKind === 'initial') {
      if (!v.pricingGroupId || !v.startAt || !v.contractDays || !v.dailyMileagePackageKm)
        error('Укажите группу, начало, целые сутки и пакет.');
      if (v.baseQuoteId || v.expectedTermsVersion)
        error('Первичный расчёт не принимает исходную редакцию.');
    } else if (!v.baseQuoteId || !v.expectedTermsVersion)
      error('Выберите подтверждённый расчёт и его версию.');
    if (v.operationKind === 'extension' && !v.addedDays) error('Укажите добавленные сутки.');
    if (['early_return', 'return'].includes(v.operationKind) && !v.actualReturnAt)
      error('Укажите фактическое время возврата.');
    if (v.operationKind === 'replacement' && (!v.replacementAt || !v.pricingGroupId))
      error('Укажите время замены и новую группу.');
    if (v.clearOverrides && v.overrides)
      error('Нельзя одновременно сбросить и задать ручные условия.');
    if (v.clearOverrides && !v.clearOverridesReason)
      error('Укажите причину сброса ручных условий.');
    if (!v.clearOverrides && v.clearOverridesReason)
      error('Причина сброса допустима только при сбросе условий.');
    if (
      v.nonBillableDays &&
      new Set(v.nonBillableDays.map((d) => d.dayIndex)).size !== v.nonBillableDays.length
    )
      error('Сутки «Вых» повторяются.');
    if (v.usages && new Set(v.usages.map((u) => u.key)).size !== v.usages.length)
      error('Участок использования повторяется.');
    // Reject fields that would otherwise appear accepted but have no effect.
    if (v.operationKind !== 'initial' && (v.startAt || v.contractDays || v.dailyMileagePackageKm))
      error('Исходное начало, пакет и срок берутся из снимка.');
    if (v.operationKind !== 'replacement' && v.operationKind !== 'initial' && v.pricingGroupId)
      error('Группа меняется только через предварительный расчёт замены.');
    if (v.operationKind !== 'extension' && v.addedDays)
      error('Добавленные сутки допустимы только при продлении.');
    if (v.operationKind !== 'replacement' && v.replacementAt)
      error('Время замены допустимо только для замены.');
    if (!['early_return', 'return'].includes(v.operationKind) && v.actualReturnAt)
      error('Время возврата допустимо только для расчёта возврата.');
  });
export type QuoteInput = z.infer<typeof quoteInput>;
export const confirmInput = z
  .object({
    expectedVersion: z.number().int().positive(),
    confirmedOverrides: z
      .array(z.enum(['price', 'late_rate', 'mileage', 'discount', 'surcharge']))
      .max(5),
  })
  .strict();
