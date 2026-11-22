import { useState } from 'react';
import { Alert, Button, Form, Space } from 'antd';
import { CustomerFields } from '../customers/CustomerFields';
import {
  companyLabels,
  identityLabels,
  personalNameLabels,
  prepareCustomerCommand,
} from '../customers/customer-fields';
import type { CustomerFormValues } from '../customers/customer-fields';
import type { Customer } from '../../domain/catalog';
import type { DocumentCommand } from './useDocumentCommand';

export function CheckoutDriver({
  customer,
  suggestedNames,
  command,
  disabled,
  onDirty,
}: {
  customer: Customer;
  suggestedNames: Record<string, string>;
  command: DocumentCommand;
  disabled: boolean;
  onDirty: (dirty: boolean) => void;
}) {
  const [form] = Form.useForm<CustomerFormValues>();
  const [changes, setChanges] = useState<Record<string, { base: string; value: string }>>({});
  const basic = {
    displayName: customer.displayName,
    phone: customer.phone,
    email: customer.email,
    inn: customer.inn,
  };
  const details = { ...customer.details, ...suggestedNames };
  const current: Record<string, string> = { ...details, ...basic };
  const detailLabels =
    customer.type === 'company' ? companyLabels : { ...personalNameLabels, ...identityLabels };
  const fields = [...Object.keys(basic), ...Object.keys(detailLabels)].map((key) => ({
    name: Object.hasOwn(basic, key) ? [key] : ['details', key],
    value: changes[key]?.value ?? current[key] ?? '',
  }));
  const hasChanges = Object.keys(changes).length > 0;
  const hasSuggestions = Object.keys(suggestedNames).length > 0;
  const hasConflict = Object.entries(changes).some(
    ([key, edit]) => edit.base !== (current[key] ?? '') && edit.value !== current[key],
  );

  function update({ details, ...basicChanges }: Partial<CustomerFormValues>) {
    const next = { ...changes };
    for (const [key, value] of Object.entries({ ...details, ...basicChanges })) {
      if (typeof value !== 'string') continue;
      const saved = current[key] ?? '';
      if (value === saved) delete next[key];
      else next[key] = { base: changes[key]?.base ?? saved, value };
    }
    setChanges(next);
    onDirty(Object.keys(next).length > 0);
  }
  function clear() {
    setChanges({});
    onDirty(false);
  }
  function save(values: CustomerFormValues) {
    command.run(
      'customers.update',
      '/customers/' + customer.id,
      {
        method: 'PATCH',
        body: prepareCustomerCommand(
          {
            ...basic,
            ...values,
            type: customer.type,
            details: { ...details, ...values.details },
            expectedVersion: customer.version,
          },
          customer,
        ),
      },
      clear,
    );
  }
  return (
    <Form
      form={form}
      layout="vertical"
      fields={fields}
      onValuesChange={update}
      onFinish={save}
      disabled={disabled}
      className="document-stack"
    >
      {hasConflict && (
        <Alert
          type="warning"
          className="notice"
          showIcon
          message="Некоторые реквизиты изменили в другом окне. Проверьте значения перед сохранением."
        />
      )}
      <CustomerFields
        form={form}
        type={customer.type}
        requiredFields={
          customer.type === 'individual' ? customer.documentReadiness.required : undefined
        }
        namesNeedReview={hasSuggestions && !disabled}
      />
      {(hasChanges || hasSuggestions) && (
        <Space>
          <Button type="primary" htmlType="submit">
            Сохранить
          </Button>
          {hasChanges && <Button onClick={clear}>Отмена</Button>}
        </Space>
      )}
    </Form>
  );
}
