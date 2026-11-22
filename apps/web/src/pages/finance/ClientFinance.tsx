import { useRef, useState } from 'react';
import { Button, Collapse, Space, Table } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { PollNotice, usePolling } from '../../catalog';
import type { CustomerFinance } from './types';
import { rub, fundNames, bucketNames } from './presentation';
import { sourceKey } from './operationData';
import { FinancialSummary } from './FinancialSummary';
import { MoneyEditor } from './MoneyEditor';
import { Journal } from './Journal';
export function ClientFinance({
  customerId,
  bookingId,
  onLock,
  compact = false,
}: {
  customerId: number;
  bookingId?: number;
  onLock?: (v: boolean) => void;
  compact?: boolean;
}) {
  const p = usePolling<CustomerFinance>('/customers/' + customerId + '/finance'),
    [editor, setEditor] = useState<{ kind: string; operationId?: number }>(),
    [locked, setLocked] = useState(false);
  const lock = (v: boolean) => {
    setLocked(v);
    onLock?.(v);
  };
  // Stable callback prevents a render/effect loop while polling updates the ledger.
  const lockRef = useRef(lock);
  lockRef.current = lock;
  const stableLock = useRef((v: boolean) => lockRef.current(v)).current;
  const done = () => {
    setEditor(undefined);
    void p.reload();
  };
  const summary = p.data?.bookings.find((b) => b.bookingId === bookingId);
  return (
    <section aria-label="Финансы клиента" className={compact ? 'booking-finance' : undefined}>
      <PollNotice {...p} />
      {summary && <FinancialSummary value={summary} compact={compact} />}
      {!editor && bookingId && summary?.paymentsAllowed && (
        <Space wrap style={{ marginBlock: 12 }}>
          <Button type="primary" onClick={() => setEditor({ kind: 'rent_payment' })}>
            Подтвердить оплату
          </Button>
          <Button onClick={() => setEditor({ kind: 'deposit_receipt' })}>Подтвердить залог</Button>
        </Space>
      )}
      {!bookingId && (
        <>
          <h3>Залоги и доступные средства</h3>
          <Table
            size="small"
            rowKey={sourceKey}
            dataSource={p.data?.sources}
            pagination={false}
            scroll={{ x: 550 }}
            columns={[
              {
                title: 'Источник',
                render: (_, s) => (
                  <>
                    №{s.lotId} · {s.origin === 'deposit' ? 'Из залога' : 'Из оплаты аренды'}
                  </>
                ),
              },
              { title: 'Назначение', dataIndex: 'bucket', render: (v) => bucketNames[v] },
              {
                title: 'Способ / фонд',
                render: (_, s) => (
                  <>
                    {s.method === 'cash' ? 'Наличные' : 'Безналичные'} ·{' '}
                    {s.fund ? fundNames[s.fund] : 'банк'}
                  </>
                ),
              },
              { title: 'Доступно', dataIndex: 'availableRub', render: rub },
            ]}
          />
        </>
      )}
      {!editor && (
        <Button
          aria-label="Возврат и доступные средства"
          className={compact ? 'booking-money-button' : undefined}
          icon={compact ? <PlusOutlined /> : undefined}
          disabled={!p.data}
          onClick={() => setEditor({ kind: 'refund' })}
        >
          Возврат и доступные средства
        </Button>
      )}
      {editor && (
        <MoneyEditor
          key={editor.kind + ':' + editor.operationId}
          customerId={customerId}
          bookingId={bookingId}
          data={p.data}
          initialKind={editor.kind}
          operationId={editor.operationId}
          onDone={done}
          onClose={() => setEditor(undefined)}
          onLock={stableLock}
        />
      )}
      <Collapse
        style={{ marginBlock: 16 }}
        items={[
          {
            key: 'journal',
            label: 'Денежные операции',
            children: (
              <Journal
                items={(p.data?.items ?? []).filter(
                  (o) => !bookingId || o.booking_id === bookingId,
                )}
                onReverse={
                  locked || editor
                    ? undefined
                    : (id) => setEditor({ kind: 'reversal', operationId: id })
                }
              />
            ),
          },
        ]}
      />
    </section>
  );
}
