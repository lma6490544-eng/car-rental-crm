import type { FinanceResponse } from '../../contracts';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Alert, Button, Card, Form, Select, Space } from 'antd';
import { PollNotice, usePolling } from '../../catalog';
import { fundNames } from './presentation';
import { rub } from '../../shared/formatters';
import { PageTitle } from '../../shared/PageTitle';
import { MoneyEditor } from './MoneyEditor';
import { ClientFinance } from './ClientFinance';
import { Journal } from './Journal';
import { useFinanceCustomerSearch } from './useFinanceCustomerSearch';
export { rub } from '../../shared/formatters';
export { ClientFinance } from './ClientFinance';
export { FinancialSummary } from './FinancialSummary';
export default function Payments() {
  const [params] = useSearchParams();
  const initialCustomer = Number(params.get('customerId'));
  const initialBooking = Number(params.get('bookingId'));
  const p = usePolling<FinanceResponse>('/finance'),
    [customer, setCustomer] = useState<number | undefined>(
      Number.isSafeInteger(initialCustomer) && initialCustomer > 0 ? initialCustomer : undefined,
    ),
    [initial, setInitial] = useState(false),
    [locked, setLocked] = useState(false),
    [reversal, setReversal] = useState<number>();
  const { options, setQuery } = useFinanceCustomerSearch();
  const completeInitial = () => {
    setInitial(false);
    void p.reload();
  };
  const completeReversal = () => {
    setReversal(undefined);
    void p.reload();
  };
  return (
    <section>
      <PageTitle>
        <h1>Платежи</h1>
      </PageTitle>
      <PollNotice {...p} />
      <Space wrap>
        {p.data?.items.map((f) => (
          <Card key={f.id} size="small" title={fundNames[f.id]}>
            <strong>{rub(f.balanceRub)}</strong>
            {!f.initialized && <div>Начальное сальдо не введено</div>}
          </Card>
        ))}
      </Space>
      {p.data && BigInt(p.data.depositShortfallRub) > 0n && (
        <Alert
          type="warning"
          message={'Дефицит обеспечения залогов: ' + rub(p.data.depositShortfallRub)}
        />
      )}
      <p>
        <Button
          disabled={
            locked ||
            initial ||
            !!customer ||
            !!reversal ||
            !p.data?.initialAllowed ||
            p.data?.items.every((f) => f.hasEntries)
          }
          onClick={() => setInitial(true)}
        >
          Ввести начальное сальдо
        </Button>
      </p>
      {initial && (
        <MoneyEditor
          initialKind="initial"
          onLock={setLocked}
          onClose={() => setInitial(false)}
          onDone={completeInitial}
        />
      )}
      <Form layout="vertical">
        <Form.Item label="Клиент для денежной операции">
          <Select
            aria-label="Клиент для денежной операции"
            style={{ minWidth: 260 }}
            showSearch
            filterOption={false}
            onSearch={setQuery}
            options={options}
            value={customer}
            allowClear
            disabled={locked || initial || !!reversal}
            onChange={setCustomer}
            placeholder="Фамилия или организация, от двух символов"
          />
        </Form.Item>
      </Form>
      {customer && (
        <ClientFinance
          key={customer}
          customerId={customer}
          bookingId={
            customer === initialCustomer &&
            Number.isSafeInteger(initialBooking) &&
            initialBooking > 0
              ? initialBooking
              : undefined
          }
          onLock={setLocked}
        />
      )}
      {reversal && (
        <MoneyEditor
          initialKind="reversal"
          operationId={reversal}
          onLock={setLocked}
          onClose={() => setReversal(undefined)}
          onDone={completeReversal}
        />
      )}
      <h2>Журнал оплат и возвратов</h2>
      <p>
        Последние 200 фактических поступлений и возвратов денег. Стоимость и изменения условий брони
        сохраняются в её истории.
      </p>
      <Journal
        items={p.data?.journal.items ?? []}
        onReverse={locked || initial || customer || reversal ? undefined : setReversal}
      />
    </section>
  );
}
