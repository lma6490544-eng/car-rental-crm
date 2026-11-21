import { z } from 'zod';
const text = (max = 250) => z.string().trim().max(max).default('');
const date = z.union([z.literal(''), z.iso.date()]).default('');
const digits = (lengths: number[]) =>
  text().refine(
    (v) => !v || (lengths.includes(v.length) && /^\d+$/.test(v)),
    'Неверный формат реквизита.',
  );
const phone = text(40)
  .transform((v) => {
    const n = v.replace(/[\s()-]/g, '');
    return /^8\d{10}$/.test(n) ? '+7' + n.slice(1) : n;
  })
  .refine((v) => !v || /^\+7\d{10}$/.test(v), 'Телефон: +7 и 10 цифр.');
export const individualDetails = z
  .object({
    lastName: text(100),
    firstName: text(100),
    middleName: text(100),
    birthDate: date,
    passportSeries: digits([4]),
    passportNumber: digits([6]),
    passportIssuer: text(500),
    passportDate: date,
    registrationAddress: text(500),
    actualAddress: text(500),
    licenseNumber: text(30),
    licenseDate: date,
  })
  .strict();
export const companyDetails = z
  .object({
    kpp: digits([9]),
    ogrn: digits([13, 15]),
    legalAddress: text(500),
    postalAddress: text(500),
    bank: text(),
    account: digits([20]),
    correspondentAccount: digits([20]),
    bik: digits([9]),
    fax: text(40),
    representativeName: text(),
    representativePhone: phone,
    authority: text(500),
  })
  .strict();
const common = {
  displayName: z.string().trim().min(1).max(250),
  phone,
  email: text().refine((v) => !v || z.email().safeParse(v).success, 'Некорректный email.'),
};
export const customerInput = z.discriminatedUnion('type', [
  z
    .object({
      ...common,
      type: z.literal('individual'),
      inn: z.literal('').default(''),
      details: individualDetails.default(() => individualDetails.parse({})),
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal('company'),
      inn: digits([10, 12]),
      details: companyDetails.default(() => companyDetails.parse({})),
    })
    .strict(),
]);
export const version = z.number().int().positive();
export const customerUpdate = z.object({ expectedVersion: version, data: customerInput }).strict();
export const reasonInput = z
  .object({ expectedVersion: version, reason: z.string().trim().min(1).max(1000) })
  .strict();
export const versionInput = z.object({ expectedVersion: version }).strict();
export const noteInput = z
  .object({ expectedVersion: version, text: z.string().trim().min(1).max(4000) })
  .strict();
// Russian visually equivalent registration letters are canonicalized; other scripts remain distinct.
export const normalizePlate = (v: string) =>
  v
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(
      /[АВЕКМНОРСТУХ]/g,
      (c) =>
        ({
          А: 'A',
          В: 'B',
          Е: 'E',
          К: 'K',
          М: 'M',
          Н: 'H',
          О: 'O',
          Р: 'P',
          С: 'C',
          Т: 'T',
          У: 'Y',
          Х: 'X',
        })[c]!,
    );
export const vehicleInput = z
  .object({
    modelId: z.number().int().positive().max(2147483647).optional(),
    brandName: text(100),
    modelName: text(100),
    pricingGroupId: z.number().int().positive().max(2147483647).optional(),
    plate: z
      .string()
      .trim()
      .min(1)
      .max(20)
      .transform(normalizePlate)
      .pipe(
        z
          .string()
          .regex(
            /^[ABEKMHOPCTYX]\d{3}[ABEKMHOPCTYX]{2}\d{2,3}$/,
            'Госномер: А 000 АА и регион из 2–3 цифр.',
          ),
      ),
    vin: text(30)
      .transform((v) => v.toUpperCase().replace(/\s/g, ''))
      .refine(
        (v) => !v || /^[A-HJ-NPR-Z0-9]{17}$/.test(v),
        'VIN должен содержать 17 латинских букв и цифр, без I, O, Q.',
      ),
    year: z
      .number()
      .int()
      .min(1900)
      .max(new Date().getUTCFullYear() + 1),
    bodyType: z.enum(['sedan', 'hatchback', 'compact_van', 'cargo_minibus']),
    transmission: z.enum(['automatic', 'manual']).nullable().default(null),
    currentMileageKm: z.number().int().min(0).max(10000000).nullable(),
    nextMaintenanceDueKm: z.number().int().min(0).max(10000000).nullable(),
    isReady: z.boolean().default(true),
    readinessReason: text(1000),
    needsWash: z.boolean().default(false),
    issueNotes: text(2000),
    note: text(2000),
  })
  .strict()
  .refine((v) => v.isReady || !!(v.note || v.readinessReason || v.issueNotes), {
    message: 'Укажите пометку о неготовности.',
    path: ['note'],
  })
  .refine((v) => !!v.modelId || !!(v.brandName && v.modelName), {
    message: 'Укажите марку и модель.',
    path: ['modelName'],
  });
export const vehicleUpdate = z
  .object({ expectedVersion: version, reason: text(1000), data: vehicleInput })
  .strict();
export const serviceInput = z
  .object({
    expectedVersion: version,
    performedOn: z.iso.date(),
    procedure: z.string().trim().min(1).max(120),
    mileageKm: z.number().int().min(0).max(10000000).nullable().default(null),
    note: text(4000),
    updateMileage: z.boolean().default(false),
    nextMaintenanceDueKm: z.number().int().min(0).max(10000000).optional(),
  })
  .strict()
  .refine((v) => !v.updateMileage || v.mileageKm !== null, {
    message: 'Укажите пробег процедуры.',
    path: ['mileageKm'],
  })
  .refine(
    (v) => v.performedOn <= new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' }),
    { message: 'Дата выполненной процедуры не может быть в будущем.', path: ['performedOn'] },
  );
export const listQuery = z
  .object({
    q: z.string().trim().max(250).default(''),
    page: z.coerce.number().int().min(1).max(100000).default(1),
    type: z.enum(['', 'individual', 'company']).default(''),
    blocked: z.enum(['', 'true', 'false']).default(''),
    bodyType: z.enum(['', 'sedan', 'hatchback', 'compact_van', 'cargo_minibus']).default(''),
    state: z.enum(['', 'ready', 'not_ready', 'wash', 'issue', 'maintenance']).default(''),
    archived: z.enum(['false', 'true']).default('false'),
    sort: z.enum(['name', 'mileage', 'maintenance']).default('name'),
    order: z.enum(['asc', 'desc']).default('asc'),
  })
  .strict();
export const serviceEditInput = z
  .object({
    expectedVersion: version,
    performedOn: z.iso.date(),
    procedure: z.string().trim().min(1).max(120),
    mileageKm: z.number().int().min(0).max(10000000).nullable().default(null),
    note: text(4000),
  })
  .strict()
  .refine(
    (v) => v.performedOn <= new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' }),
    { message: 'Дата выполненной процедуры не может быть в будущем.', path: ['performedOn'] },
  );
export function documentReadiness(type: string, data: Record<string, string>, inn: string) {
  const required =
    type === 'individual'
      ? [
          'birthDate',
          'passportSeries',
          'passportNumber',
          'passportIssuer',
          'passportDate',
          'registrationAddress',
          'licenseNumber',
          'licenseDate',
        ]
      : [
          'kpp',
          'ogrn',
          'legalAddress',
          'bank',
          'account',
          'correspondentAccount',
          'bik',
          'representativeName',
          'authority',
        ];
  const missing = required.filter((key) => !data[key]);
  if (type === 'company' && !inn) missing.push('inn');
  return { ready: missing.length === 0, missing };
}
