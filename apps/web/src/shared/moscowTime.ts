// Form conversions preserve the CRM's fixed UTC+03:00 convention.
// Localized display, including historical time zones, remains separate.
export const DAY_MS = 86400000;
const MOSCOW_OFFSET_MS = 10800000;
const instantMs = (value: string | number) =>
  typeof value === 'number' ? value : Date.parse(value);
export const moscowDateTimeInput = (value: string | number) =>
  new Date(instantMs(value) + MOSCOW_OFFSET_MS).toISOString().slice(0, 16);
export const moscowDate = (value: string | number) =>
  new Date(instantMs(value) + MOSCOW_OFFSET_MS).toISOString().slice(0, 10);
export const moscowDayStart = (date: string) => Date.parse(date + 'T00:00:00+03:00');
// Booking and technical forms supply minute precision; invalid inputs still throw.
export const moscowMinuteToIso = (value: string) => new Date(value + ':00+03:00').toISOString();
// Pricing preserves expanded strings rather than normalizing them to UTC.
export const withMoscowMinuteOffset = (value: string) =>
  value.length === 16 ? value + ':00+03:00' : value;
