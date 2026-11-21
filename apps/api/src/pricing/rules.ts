// Versioned source price list: TZ v1.1 §6.3.2; Q1–Q17 override its prose.
// Never edit a published version: add a new dated entry instead.
const originalRules = {
  version: 'tz-1.1-q17-v1',
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  effectiveTo: null as string | null,
  lateHourRub: '300',
  excessKmRub: '7',
  fuelLiterRub: '80',
  washRub: '1000',
  groups: [
    {
      code: 'economy',
      name: 'Nexia / Fabia / Logan',
      category: 'passenger',
      rates: {
        100: ['1900', '1600', '1500'],
        250: ['2000', '1700', '1600'],
        400: ['2200', '2000', '1800'],
      },
    },
    {
      code: 'standard',
      name: 'Polo / Solaris / Almera',
      category: 'passenger',
      rates: {
        100: ['2300', '2000', '1800'],
        250: ['2600', '2100', '1900'],
        400: ['2700', '2600', '2500'],
      },
    },
    {
      code: 'comfort',
      name: 'Jetta / Octavia',
      category: 'passenger',
      rates: {
        100: ['2700', '2500', '2100'],
        250: ['3000', '2850', '2700'],
        400: ['3250', '3000', '2900'],
      },
    },
    {
      code: 'berlingo',
      name: 'Berlingo',
      category: 'minibus',
      rates: {
        100: ['2100', '2000', '2000'],
        250: ['2200', '2100', '2100'],
        400: ['2500', '2400', '2400'],
      },
    },
    {
      code: 'cargo',
      name: 'Boxer / Jumper / Sprinter / Transit',
      category: 'minibus',
      rates: {
        100: ['4400', '4000', '4000'],
        250: ['4600', '4100', '4100'],
        400: ['4900', '4900', '4900'],
      },
    },
  ],
};
export type Rules = typeof originalRules;
// Daily-price semantics replace the former total-price override. Published
// snapshots keep v1; outstanding v1 previews must be recalculated before signing.
export const ruleSets: Rules[] = [
  { ...originalRules, effectiveTo: '2026-11-13T00:00:00.000Z' },
  {
    ...structuredClone(originalRules),
    version: 'tz-1.1-q17-v2-daily-price',
    effectiveFrom: '2026-11-13T00:00:00.000Z',
    effectiveTo: '2026-11-13T10:01:56.000Z',
  },
  {
    ...structuredClone(originalRules),
    version: 'tz-1.1-q17-v3-preserve-extension',
    effectiveFrom: '2026-11-13T10:01:56.000Z',
    effectiveTo: '2026-11-13T10:13:03.000Z',
  },
  {
    ...structuredClone(originalRules),
    version: 'tz-1.1-q17-v4-early-full-days-hours',
    effectiveFrom: '2026-11-13T10:13:03.000Z',
    effectiveTo: '2026-11-13T10:26:20.000Z',
  },
  {
    ...structuredClone(originalRules),
    version: 'tz-1.1-q17-v5-minimum-mileage-package',
    effectiveFrom: '2026-11-13T10:26:20.000Z',
  },
];
