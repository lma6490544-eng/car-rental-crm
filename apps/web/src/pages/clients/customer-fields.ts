import type { Customer } from '../../catalog';

export const identityLabels: Record<string, string> = {
  birthDate: 'Дата рождения',
  passportSeries: 'Серия паспорта',
  passportNumber: 'Номер паспорта',
  passportIssuer: 'Кем выдан паспорт',
  passportDate: 'Дата выдачи паспорта',
  registrationAddress: 'Адрес регистрации',
  actualAddress: 'Фактический адрес',
  licenseNumber: 'Водительское удостоверение',
  licenseDate: 'Дата выдачи ВУ',
};
export const companyLabels: Record<string, string> = {
  kpp: 'КПП',
  ogrn: 'ОГРН / ОГРНИП',
  legalAddress: 'Юридический адрес',
  postalAddress: 'Почтовый адрес',
  bank: 'Банк',
  account: 'Расчётный счёт',
  correspondentAccount: 'Корреспондентский счёт',
  bik: 'БИК',
  fax: 'Факс',
  representativeName: 'ФИО представителя',
  representativePhone: 'Телефон представителя',
  authority: 'Основание полномочий',
};
export type CustomerFormValues = Pick<Customer, 'type' | 'displayName'> &
  Partial<Pick<Customer, 'phone' | 'email' | 'inn' | 'details'>> & {
    expectedVersion?: number;
  };

export function prepareCustomerCommand(
  {
    expectedVersion,
    type,
    displayName,
    phone = '',
    email = '',
    inn = '',
    details = {},
  }: CustomerFormValues,
  editing: boolean,
) {
  const data = { type, displayName, phone, email, inn: type === 'company' ? inn : '', details };
  return editing ? { expectedVersion, data } : data;
}
