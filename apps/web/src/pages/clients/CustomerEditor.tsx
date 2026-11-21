import { Form, Input, Select } from 'antd';
import type { FormItemProps } from 'antd';
import { CommandModal } from '../../catalog';
import type { Customer } from '../../catalog';
import { PhoneInput, phoneRules } from '../../formats';
import { companyLabels, identityLabels, prepareCustomerCommand } from './customer-fields';
import type { CustomerFormValues } from './customer-fields';

const passportFieldLengths: Partial<Record<string, number>> = {
  passportSeries: 4,
  passportNumber: 6,
};

export function CustomerEditor({
  customer,
  current,
  onClose,
  onDone,
}: {
  customer?: Customer;
  current?: Customer;
  onClose: () => void;
  onDone: (result: Pick<Customer, 'id'>) => void;
}) {
  const [form] = Form.useForm<CustomerFormValues>();
  const type: Customer['type'] = Form.useWatch('type', form) ?? customer?.type ?? 'individual';
  const resetDetails = () => form.setFieldsValue({ details: {}, inn: '' });
  const prepare = (values: CustomerFormValues) => prepareCustomerCommand(values, !!customer);
  return (
    <CommandModal
      title={customer ? 'Редактирование клиента' : 'Новый клиент'}
      path={customer ? '/customers/' + customer.id : '/customers'}
      command={customer ? 'customers.update' : 'customers.create'}
      method={customer ? 'PATCH' : 'POST'}
      initial={customer ? { ...customer } : { type: 'individual', details: {} }}
      version={customer?.version}
      currentVersion={current?.version}
      form={form}
      onClose={onClose}
      onDone={onDone}
      currentValues={
        current && (
          <details>
            <summary>Актуальные реквизиты</summary>
            <p>
              {current.displayName} · {current.phone} · {current.email} · {current.inn}
            </p>
            {Object.entries(current.details).map(([key, value]) => (
              <p key={key}>
                {{ ...identityLabels, ...companyLabels }[key] ?? key}: {value || '—'}
              </p>
            ))}
          </details>
        )
      }
      prepare={prepare}
    >
      <div className="form-grid">
        <Form.Item name="type" label="Тип клиента">
          <Select
            disabled={!!customer}
            onChange={resetDetails}
            options={[
              { value: 'individual', label: 'Физическое лицо' },
              { value: 'company', label: 'Организация' },
            ]}
          />
        </Form.Item>
        <Form.Item
          name="displayName"
          label={type === 'individual' ? 'ФИО' : 'Название организации'}
          rules={[{ required: true, whitespace: true, message: 'Укажите имя или название.' }]}
        >
          <Input maxLength={250} />
        </Form.Item>
        <Form.Item name="phone" label="Телефон" rules={phoneRules}>
          <PhoneInput />
        </Form.Item>
        <Form.Item
          name="email"
          label="Email"
          rules={[{ type: 'email', message: 'Некорректный email.' }]}
        >
          <Input maxLength={250} />
        </Form.Item>
        {type === 'company' && (
          <Form.Item name="inn" label="ИНН">
            <Input maxLength={12} />
          </Form.Item>
        )}
      </div>
      <div className="form-grid" key={type}>
        {Object.entries(type === 'individual' ? identityLabels : companyLabels).map(
          ([key, label]) => {
            const length = passportFieldLengths[key];
            const rules: FormItemProps['rules'] = key === 'representativePhone' ? phoneRules : [];
            if (length) {
              rules.push({
                pattern: new RegExp('^\\d{' + length + '}$'),
                message: 'Введите ровно ' + length + ' цифр.',
              });
            }
            return (
              <Form.Item
                key={key}
                name={['details', key]}
                label={label}
                preserve={false}
                rules={rules}
              >
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
          },
        )}
      </div>
    </CommandModal>
  );
}
