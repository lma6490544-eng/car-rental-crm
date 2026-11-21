export const names: Record<string, string> = {
  rent_payment: 'Оплата аренды',
  deposit_receipt: 'Получение залога',
  to_credit: 'Перевести в остаток клиента',
  credit_use: 'Зачесть остаток в оплату',
  refund: 'Возврат денег',
  initial: 'Начальное сальдо',
  reversal: 'Компенсация операции',
  charge: 'Изменение начисления',
};
export const fundNames: Record<string, string> = {
  operating_cash: 'Касса',
  deposit_pool: 'Залоги',
};
export const bucketNames: Record<string, string> = {
  rent: 'Оплата аренды',
  deposit: 'Залог',
  credit: 'Доступный остаток',
};
export { rub } from '../../shared/formatters';
