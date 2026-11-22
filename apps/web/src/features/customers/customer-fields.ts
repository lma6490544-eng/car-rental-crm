import type { Customer } from '../../catalog';

export const personalNameLabels = { lastName: 'Фамилия', firstName: 'Имя', middleName: 'Отчество' };

export function personalFullName(details: Customer['details']) {
  return [details.lastName, details.firstName, details.middleName]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(' ');
}

export function suggestPersonalName(customer: Customer): Record<string, string> {
  if (customer.type !== 'individual') return {};
  const [lastName, firstName, ...patronymic] = customer.displayName.trim().split(/\s+/);
  const parts = { lastName, firstName, middleName: patronymic.join(' ') };
  return Object.fromEntries(
    Object.entries(parts).filter(([key, value]) => value && !customer.details[key]?.trim()),
  );
}

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

export const passportFields = [
  'passportSeries',
  'passportNumber',
  'birthDate',
  'passportIssuer',
  'passportDate',
  'registrationAddress',
  'actualAddress',
];
export const licenseFields = ['licenseNumber', 'licenseDate'];
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
export const companyFieldGroups = [
  { key: 'organization', title: 'Организация', fields: ['displayName', 'inn', 'kpp', 'ogrn'] },
  {
    key: 'contacts',
    title: 'Контакты и адреса',
    fields: ['phone', 'email', 'legalAddress', 'postalAddress', 'fax'],
  },
  {
    key: 'bank',
    title: 'Банковские реквизиты',
    fields: ['bank', 'account', 'correspondentAccount', 'bik'],
  },
  {
    key: 'representative',
    title: 'Представитель',
    fields: ['representativeName', 'representativePhone', 'authority'],
  },
] as const;

export type CustomerFormValues = Pick<Customer, 'type'> &
  Partial<Pick<Customer, 'displayName' | 'phone' | 'email' | 'inn' | 'details'>> & {
    expectedVersion?: number;
  };

export function prepareCustomerCommand(
  {
    expectedVersion,
    type,
    displayName = '',
    phone = '',
    email = '',
    inn = '',
    details = {},
  }: CustomerFormValues,
  customer?: Customer,
) {
  let name = displayName;
  if (customer && type === 'individual') {
    const nameChanged = Object.keys(personalNameLabels).some(
      (key) => (details[key]?.trim() ?? '') !== (customer.details[key]?.trim() ?? ''),
    );
    const reviewedName = Object.keys(suggestPersonalName(customer)).length > 0;
    name = nameChanged || reviewedName ? personalFullName(details) : customer.displayName;
  }
  const data = {
    type,
    displayName: name,
    phone,
    email,
    inn: type === 'company' ? inn : '',
    details,
  };
  return customer ? { expectedVersion, data } : data;
}
