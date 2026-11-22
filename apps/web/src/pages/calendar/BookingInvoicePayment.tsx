import { Alert, App, Button, Form, Input, Modal } from 'antd';
import { useContext, useId, useState } from 'react';
import type { FinancialSummary, RentPaymentProgress } from '../../contracts';
import { rub } from '../../shared/formatters';
import { moscowDate } from '../../shared/moscowTime';
import Action, { CommandLock } from './CalendarAction';
import { RentPaymentSummary } from './RentPaymentStatus';

export function BookingInvoicePayment({
  payment,
  summary,
  onDone,
}: {
  payment: RentPaymentProgress;
  summary: FinancialSummary;
  onDone: () => void;
}) {
  const { message } = App.useApp();
  const { locked } = useContext(CommandLock);
  const [confirmation, setConfirmation] = useState<{ coverageRub: string; version: number }>();
  const [amount, setAmount] = useState('');
  const [paidOn, setPaidOn] = useState('');
  const [reference, setReference] = useState('');
  const fieldId = useId();
  const today = moscowDate(Date.now());
  const canConfirm = summary.status === 'confirmed' && payment.remainingRub !== '0';
  const balanceChanged =
    !!confirmation &&
    (confirmation.coverageRub !== payment.receivedRub ||
      confirmation.version !== summary.bookingVersion);
  const validAmount =
    /^[1-9]\d{0,18}$/.test(amount) && BigInt(amount) <= BigInt(payment.remainingRub);

  function beginConfirmation() {
    setAmount(payment.remainingRub);
    setPaidOn(today);
    setReference('');
    setConfirmation({ coverageRub: payment.receivedRub, version: summary.bookingVersion });
  }

  return (
    <div className="booking-invoice-payment">
      <RentPaymentSummary payment={payment} />
      {canConfirm && (
        <Button onClick={beginConfirmation} disabled={locked}>
          Подтвердить поступление
        </Button>
      )}
      <Modal
        open={!!confirmation}
        title="Подтвердить поступление по счёту"
        onCancel={() => setConfirmation(undefined)}
        closable={!locked}
        keyboard={!locked}
        maskClosable={!locked}
        destroyOnHidden
        footer={
          <Action
            path="/financial-operations/invoice-receipt"
            command="finance.post"
            label="Подтвердить поступление"
            disabled={
              !confirmation ||
              balanceChanged ||
              !canConfirm ||
              !validAmount ||
              !paidOn ||
              paidOn > today
            }
            body={() => ({
              bookingId: summary.bookingId,
              customerId: summary.customerId,
              expectedVersion: confirmation?.version,
              expectedCoverageRub: confirmation?.coverageRub,
              amountRub: amount,
              paidOn,
              ...(reference.trim() ? { reference: reference.trim() } : {}),
            })}
            onDone={() => {
              setConfirmation(undefined);
              void message.success('Поступление подтверждено');
              onDone();
            }}
          />
        }
      >
        <p>Подтвердите сумму после сверки с выпиской или бухгалтерией.</p>
        {balanceChanged && !locked && (
          <Alert
            type="warning"
            message="Остаток изменился. Закройте окно и проверьте актуальную сумму."
          />
        )}
        <Form layout="vertical" disabled={locked}>
          <Form.Item
            label="Сумма поступления, ₽"
            htmlFor={fieldId + '-amount'}
            validateStatus={validAmount ? undefined : 'error'}
            help={validAmount ? undefined : 'Введите сумму от 1 ₽ до ' + rub(payment.remainingRub)}
          >
            <Input
              id={fieldId + '-amount'}
              inputMode="numeric"
              value={amount}
              onChange={(event) => setAmount(event.target.value.trim())}
            />
          </Form.Item>
          <Form.Item label="Дата поступления" htmlFor={fieldId + '-date'}>
            <Input
              id={fieldId + '-date'}
              type="date"
              max={today}
              value={paidOn}
              onChange={(event) => setPaidOn(event.target.value)}
            />
          </Form.Item>
          <Form.Item
            label="Номер платёжного поручения (если известен)"
            htmlFor={fieldId + '-reference'}
          >
            <Input
              id={fieldId + '-reference'}
              maxLength={120}
              value={reference}
              onChange={(event) => setReference(event.target.value)}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
