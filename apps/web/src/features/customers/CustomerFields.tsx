import { Alert, Form, Input, Select } from 'antd';
import type { FormInstance, FormItemProps } from 'antd';
import type { ReactElement } from 'react';
import {
  ApartmentOutlined,
  BankOutlined,
  CarOutlined,
  ContactsOutlined,
  IdcardOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { PhoneInput, phoneRules } from '../../formats';
import {
  companyFieldGroups,
  companyLabels,
  identityLabels,
  licenseFields,
  passportFields,
  personalNameLabels,
} from './customer-fields';
import type { CustomerFormValues } from './customer-fields';

const passportFieldLengths: Partial<Record<string, number>> = {
  passportSeries: 4,
  passportNumber: 6,
};

const companyGroupIcons = {
  organization: ApartmentOutlined,
  contacts: ContactsOutlined,
  bank: BankOutlined,
  representative: UserOutlined,
};

export function CustomerFields({
  form,
  type,
  creating = false,
  namesNeedReview = false,
  requiredFields = [],
}: {
  form: FormInstance<CustomerFormValues>;
  type: CustomerFormValues['type'];
  creating?: boolean;
  namesNeedReview?: boolean;
  requiredFields?: string[];
}) {
  const requiredRule = (key: string, label: string): NonNullable<FormItemProps['rules']> =>
    requiredFields.includes(key)
      ? [{ required: true, whitespace: true, message: 'Заполните поле «' + label + '».' }]
      : [];
  const resetDetails = () => form.setFieldsValue({ details: {}, inn: '' });
  const commonFields: Partial<Record<string, ReactElement>> = {
    displayName: (
      <Form.Item
        key="displayName"
        name="displayName"
        label={type === 'individual' ? 'ФИО' : 'Название организации'}
        rules={[{ required: true, whitespace: true, message: 'Укажите имя или название.' }]}
      >
        <Input maxLength={250} />
      </Form.Item>
    ),
    phone: (
      <Form.Item
        key="phone"
        name="phone"
        label="Телефон"
        rules={[...requiredRule('phone', 'Телефон'), ...phoneRules]}
      >
        <PhoneInput />
      </Form.Item>
    ),
    email: (
      <Form.Item
        key="email"
        name="email"
        label="Электронная почта"
        rules={[{ type: 'email', message: 'Некорректный email.' }]}
      >
        <Input maxLength={250} />
      </Form.Item>
    ),
    inn: (
      <Form.Item key="inn" name="inn" label="ИНН">
        <Input maxLength={12} />
      </Form.Item>
    ),
  };
  const basicFields = (
    <div className="form-grid">
      {creating && (
        <Form.Item name="type" label="Тип клиента">
          <Select
            onChange={resetDetails}
            options={[
              { value: 'individual', label: 'Физическое лицо' },
              { value: 'company', label: 'Организация' },
            ]}
          />
        </Form.Item>
      )}
      {type === 'individual' && !creating
        ? Object.entries(personalNameLabels).map(([key, label]) => (
            <Form.Item
              key={key}
              name={['details', key]}
              label={label}
              rules={
                key === 'middleName'
                  ? []
                  : [
                      {
                        required: true,
                        whitespace: true,
                        message: 'Заполните поле «' + label + '».',
                      },
                    ]
              }
            >
              <Input maxLength={100} />
            </Form.Item>
          ))
        : commonFields.displayName}
      {commonFields.phone}
      {commonFields.email}
      {type === 'company' && commonFields.inn}
    </div>
  );
  const labels = type === 'individual' ? identityLabels : companyLabels;
  function detailField(key: string) {
    const label = labels[key];
    const length = passportFieldLengths[key];
    const rules = requiredRule(key, label);
    if (key === 'representativePhone') rules.push(...phoneRules);
    if (length) {
      rules.push({
        pattern: new RegExp('^\\d{' + length + '}$'),
        message: 'Введите ровно ' + length + ' цифр.',
      });
    }
    return (
      <Form.Item key={key} name={['details', key]} label={label} preserve={false} rules={rules}>
        {key === 'representativePhone' ? (
          <PhoneInput />
        ) : (
          <Input
            type={key.endsWith('Date') ? 'date' : 'text'}
            inputMode={length ? 'numeric' : undefined}
            maxLength={length ?? 500}
          />
        )}
      </Form.Item>
    );
  }
  return (
    <>
      {namesNeedReview && (
        <Alert
          type="info"
          className="notice"
          showIcon
          message="Части имени подставлены из карточки клиента. Проверьте их и сохраните реквизиты."
        />
      )}
      {type === 'individual' && !creating ? (
        <div className="customer-form-groups">
          <section
            className="customer-form-group customer-form-group-three"
            aria-label="Личные данные"
          >
            <h3>
              <UserOutlined aria-hidden="true" /> Личные данные
            </h3>
            {basicFields}
          </section>
          <section className="customer-form-group customer-form-group-three" aria-label="Паспорт">
            <h3>
              <IdcardOutlined aria-hidden="true" /> Паспорт
            </h3>
            <div className="form-grid">{passportFields.map(detailField)}</div>
          </section>
          <section className="customer-form-group" aria-label="Водительское удостоверение">
            <h3>
              <CarOutlined aria-hidden="true" /> Водительское удостоверение
            </h3>
            <div className="form-grid">{licenseFields.map(detailField)}</div>
          </section>
        </div>
      ) : null}
      {type === 'company' && !creating && (
        <div className="customer-form-groups">
          {companyFieldGroups.map(({ key, title, fields }) => {
            const Icon = companyGroupIcons[key];
            return (
              <section key={key} className="customer-form-group" aria-label={title}>
                <h3>
                  <Icon aria-hidden="true" /> {title}
                </h3>
                <div className="form-grid">
                  {fields.map((field) => commonFields[field] ?? detailField(field))}
                </div>
              </section>
            );
          })}
        </div>
      )}
      {creating && (
        <>
          {basicFields}
          <div className="form-grid" key={type}>
            {Object.keys(labels).map(detailField)}
          </div>
        </>
      )}
    </>
  );
}
