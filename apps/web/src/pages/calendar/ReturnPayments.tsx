import { useEffect, useState } from 'react';
import { SafetyOutlined } from '@ant-design/icons';
import { Alert, Button, Checkbox, Input, Radio } from 'antd';
import type { ApiError } from '../../api';
import type { DocumentCommand } from '../../features/documents/useDocumentCommand';
import { rub } from '../../shared/formatters';
import { parseReceiptRub, PaymentColumn } from './CheckoutPayment';
import { local } from './dates';
import type { RentalReturnData } from './RentalReturn';

type DepositChoice = 'return' | 'partial' | 'reserve';

export function ReturnPayments({
  data,
  rentBalance,
  confirmed,
  command,
  disabled,
  onDirty,
}: {
  data: RentalReturnData;
  rentBalance: { due: string; price: string; received: string } | null;
  confirmed: boolean;
  command: DocumentCommand;
  disabled: boolean;
  onDirty: (dirty: boolean) => void;
}) {
  const [rentDirty, setRentDirty] = useState(false);
  const [depositDirty, setDepositDirty] = useState(false);
  const dirty = rentDirty || depositDirty;
  useEffect(() => onDirty(dirty), [dirty, onDirty]);

  const finance = data.finance;
  const booking = {
    bookingId: finance.bookingId,
    customerId: finance.customerId,
    expectedVersion: finance.bookingVersion,
  };

  function receiveRent(
    kind: 'rent_payment' | 'deposit_receipt',
    cash: bigint,
    bank: bigint,
    onConfirmed: () => void,
  ) {
    if (!confirmed) return;
    command.run(
      'finance.post',
      '/financial-operations/checkout-receipt',
      {
        body: {
          ...booking,
          kind,
          cashRub: cash.toString(),
          bankRub: bank.toString(),
          returnDebtRub: finance.debtRub,
          reason: 'Доплата при приёмке автомобиля',
        },
      },
      onConfirmed,
    );
  }

  return (
    <div className="checkout-payment checkout-return-payments">
      <PaymentColumn
        key={confirmed && rentBalance?.due === '0' ? 'settled' : 'due'}
        kind="rent_payment"
        due={rentBalance?.due ?? null}
        price={rentBalance?.price}
        received={rentBalance?.received ?? finance.coverageRub}
        returnSettlement
        confirmationBlocked={!confirmed}
        locked={disabled}
        onDirty={setRentDirty}
        onConfirm={receiveRent}
      />
      <DepositColumn
        key={finance.depositRub}
        booking={booking}
        depositRub={finance.depositRub}
        reserves={data.reserves}
        confirmed={confirmed}
        command={command}
        disabled={disabled}
        onDirty={setDepositDirty}
      />
    </div>
  );
}

function DepositColumn({
  booking,
  depositRub,
  reserves,
  confirmed,
  command,
  disabled,
  onDirty,
}: {
  booking: { bookingId: number; customerId: number; expectedVersion: number };
  depositRub: string;
  reserves: RentalReturnData['reserves'];
  confirmed: boolean;
  command: DocumentCommand;
  disabled: boolean;
  onDirty: (dirty: boolean) => void;
}) {
  const [choice, setChoice] = useState<DepositChoice>();
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [warning, setWarning] = useState<{ token: string; message: string }>();
  const [accepted, setAccepted] = useState(false);
  const deposit = BigInt(depositRub);
  const dirty = choice !== undefined;
  useEffect(() => onDirty(dirty), [dirty, onDirty]);

  let reserve: bigint | undefined;
  if (choice === 'return') reserve = 0n;
  if (choice === 'reserve') reserve = deposit;
  if (choice === 'partial') {
    const partial = parseReceiptRub(amount);
    if (partial !== undefined && partial > 0n && partial < deposit) reserve = partial;
  }

  function clearWarning() {
    setWarning(undefined);
    setAccepted(false);
  }

  function showShortfall(error: ApiError) {
    if (error.code !== 'FUND_SHORTFALL_CONFIRMATION') return false;
    const details = error.details;
    if (
      !details ||
      typeof details !== 'object' ||
      !('token' in details) ||
      typeof details.token !== 'string'
    )
      return false;
    setWarning({ token: details.token, message: error.message });
    setAccepted(false);
    return true;
  }

  function confirmDeposit() {
    if (!confirmed || reserve === undefined || disabled || !reason.trim() || (warning && !accepted))
      return;
    command.run(
      'finance.post',
      '/financial-operations',
      {
        body: {
          ...booking,
          kind: 'deposit_settlement',
          expectedDepositRub: depositRub,
          reserveRub: reserve.toString(),
          reason: reason.trim(),
          ...(warning ? { warningToken: warning.token, shortfallAcknowledged: true } : {}),
        },
      },
      () => {
        setChoice(undefined);
        setAmount('');
        setReason('');
        clearWarning();
      },
      showShortfall,
    );
  }

  return (
    <section className="checkout-payment-column" aria-label="Залог">
      <div className="checkout-payment-summary">
        <SafetyOutlined aria-hidden="true" />
        <div>
          <h3>Залог</h3>
          <dl className="checkout-payment-totals">
            <div>
              <dt>Залог на руках</dt>
              <dd>{rub(depositRub)}</dd>
            </div>
            {reserves.map(({ amountRub, releaseAt }) => (
              <div key={releaseAt}>
                <dt>Резерв до {local(releaseAt).replace('T', ' ')}</dt>
                <dd>{rub(amountRub)}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
      {deposit > 0n && (
        <div className="checkout-payment-form">
          <fieldset className="checkout-payment-methods">
            <legend>Что сделать с залогом</legend>
            <Radio.Group
              className="checkout-deposit-options"
              value={choice}
              disabled={disabled}
              onChange={(event) => {
                setChoice(event.target.value);
                clearWarning();
              }}
            >
              <Radio value="return">Вернуть полностью</Radio>
              <Radio value="partial">Оставить часть в резерве на штрафы</Radio>
              <Radio value="reserve">Оставить весь залог в резерве на штрафы</Radio>
            </Radio.Group>
          </fieldset>
          {choice === 'partial' && (
            <label className="document-field">
              <span>Сумма резерва</span>
              <Input
                inputMode="numeric"
                maxLength={19}
                suffix="₽"
                value={amount}
                disabled={disabled}
                status={amount && reserve === undefined ? 'error' : undefined}
                onChange={(event) => {
                  setAmount(event.target.value);
                  clearWarning();
                }}
              />
            </label>
          )}
          {choice && (
            <label className="document-field">
              <span>Причина операции</span>
              <Input
                value={reason}
                maxLength={1000}
                disabled={disabled}
                onChange={(event) => {
                  setReason(event.target.value);
                  clearWarning();
                }}
              />
            </label>
          )}
          <dl className="checkout-payment-totals checkout-payment-calculation" aria-live="polite">
            <div>
              <dt>Выдать наличными</dt>
              <dd>{reserve === undefined ? '—' : rub((deposit - reserve).toString())}</dd>
            </div>
            <div>
              <dt>Оставить в резерве</dt>
              <dd>{reserve === undefined ? '—' : rub(reserve.toString())}</dd>
            </div>
          </dl>
          {warning && (
            <Alert
              showIcon
              type="warning"
              message={warning.message}
              description={
                <Checkbox
                  checked={accepted}
                  disabled={disabled}
                  onChange={(event) => setAccepted(event.target.checked)}
                >
                  Подтверждаю фактическую выдачу наличных
                </Checkbox>
              }
            />
          )}
          <Button
            className="checkout-primary-button"
            type="primary"
            disabled={
              !confirmed ||
              disabled ||
              reserve === undefined ||
              !reason.trim() ||
              (!!warning && !accepted)
            }
            onClick={confirmDeposit}
          >
            Подтвердить расчёт по залогу
          </Button>
        </div>
      )}
    </section>
  );
}
