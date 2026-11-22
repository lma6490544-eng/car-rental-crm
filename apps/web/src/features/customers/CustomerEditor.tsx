import { Form } from 'antd';
import { CommandModal } from '../../catalog';
import type { Customer } from '../../catalog';
import { CustomerFields } from './CustomerFields';
import {
  companyLabels,
  identityLabels,
  personalNameLabels,
  prepareCustomerCommand,
  suggestPersonalName,
} from './customer-fields';
import type { CustomerFormValues } from './customer-fields';

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
  const suggestions = customer ? suggestPersonalName(customer) : {};
  const prepare = (values: CustomerFormValues) =>
    prepareCustomerCommand({ ...values, type: customer?.type ?? values.type }, customer);
  return (
    <CommandModal
      title={customer ? 'Редактирование клиента' : 'Новый клиент'}
      path={customer ? '/customers/' + customer.id : '/customers'}
      command={customer ? 'customers.update' : 'customers.create'}
      method={customer ? 'PATCH' : 'POST'}
      initial={
        customer
          ? { ...customer, details: { ...customer.details, ...suggestions } }
          : { type: 'individual', details: {} }
      }
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
                {{ ...personalNameLabels, ...identityLabels, ...companyLabels }[key] ?? key}:{' '}
                {value || '—'}
              </p>
            ))}
          </details>
        )
      }
      prepare={prepare}
    >
      <CustomerFields
        form={form}
        type={type}
        creating={!customer}
        namesNeedReview={Object.keys(suggestions).length > 0}
      />
    </CommandModal>
  );
}
