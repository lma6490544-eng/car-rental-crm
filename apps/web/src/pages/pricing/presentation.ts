export const names: Record<string, string> = {
  initial: 'Первичный расчёт',
  extension: 'Продление',
  early_return: 'Досрочный возврат',
  replacement: 'Замена группы',
  non_billable_day: 'Изменить согласованные «Вых»',
  adjustment: 'Ручные условия',
  return: 'Возврат и доплаты',
};
export const overrideNames: Record<string, string> = {
  price: 'Собственная цена за сутки',
  late_rate: 'Прежняя ставка опоздания',
  mileage: 'Индивидуальный лимит',
  discount: 'Скидка',
  surcharge: 'Ручная доплата',
};
export const rub = (v: string) => new Intl.NumberFormat('ru-RU').format(BigInt(v)) + ' ₽';
