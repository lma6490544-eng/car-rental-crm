export const dateText = (value: string) =>
  new Date(value).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });

export const rub = (v: string | undefined) =>
  v === undefined ? '—' : BigInt(v).toLocaleString('ru-RU') + ' ₽';
