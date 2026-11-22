import { useEffect, useState } from 'react';
import {
  CalendarOutlined,
  CreditCardOutlined,
  EditOutlined,
  MoneyCollectOutlined,
  SafetyOutlined,
} from '@ant-design/icons';
import { Button, Checkbox, Input } from 'antd';
import type { FinancialSummary, RentPaymentProgress } from '../../contracts';
import type { DocumentCommand } from '../../features/documents/useDocumentCommand';
import { rub } from '../../shared/formatters';
import { RentPaymentSummary } from './RentPaymentStatus';

type ReceiptKind = 'rent_payment' | 'deposit_receipt';
type Method = 'cash' | 'bank';
const paymentMethods = [
  { method: 'cash', label: 'Наличными', Icon: MoneyCollectOutlined },
  { method: 'bank', label: 'Картой', Icon: CreditCardOutlined },
] as const;
const maxRub = 9223372036854775807n;

export function remainingDepositRub(target: string | null, received: string) {
  const balance = BigInt(target ?? '0') - BigInt(received);
  return balance > 0n ? balance.toString() : '0';
}

function parseRub(value: string) {
  if (!/^\d{1,19}$/.test(value)) return undefined;
  const amount = BigInt(value);
  return amount <= maxRub ? amount : undefined;
}

export function CheckoutPayment({
  summary,
  invoicePayment,
  requiredDeposit,
  command,
  disabled,
  onDirty,
}: {
  summary: FinancialSummary;
  invoicePayment?: RentPaymentProgress;
  requiredDeposit: string | null;
  command: DocumentCommand;
  disabled: boolean;
  onDirty: (dirty: boolean) => void;
}) {
  const [rentDirty, setRentDirty] = useState(false);
  const [depositDirty, setDepositDirty] = useState(false);
  const dirty = rentDirty || depositDirty;
  useEffect(() => onDirty(dirty), [dirty, onDirty]);

  const depositTarget = requiredDeposit ?? summary.suggestedDepositRub;
  const rentDue = invoicePayment?.remainingRub ?? summary.debtRub;
  const depositDue =
    depositTarget === null ? null : remainingDepositRub(depositTarget, summary.depositRub);
  const locked = disabled || command.locked || !summary.paymentsAllowed;

  function receive(kind: ReceiptKind, cashRub: bigint, bankRub: bigint, onConfirmed: () => void) {
    command.run(
      'finance.post',
      '/financial-operations/checkout-receipt',
      {
        body: {
          kind,
          cashRub: cashRub.toString(),
          bankRub: bankRub.toString(),
          expectedVersion: summary.bookingVersion,
          bookingId: summary.bookingId,
          customerId: summary.customerId,
          reason:
            kind === 'rent_payment'
              ? 'Оплата аренды при оформлении'
              : 'Получение залога при оформлении',
        },
      },
      onConfirmed,
    );
  }

  return (
    <div className="checkout-payment">
      <PaymentColumn
        key={rentDue === '0' ? 'rent-settled' : 'rent-due'}
        kind="rent_payment"
        due={rentDue}
        price={summary.priceRub}
        received={invoicePayment?.receivedRub ?? summary.coverageRub}
        invoicePayment={invoicePayment}
        locked={locked}
        onDirty={setRentDirty}
        onConfirm={receive}
      />
      <PaymentColumn
        key={depositDue === null || depositDue === '0' ? 'deposit-closed' : 'deposit-due'}
        kind="deposit_receipt"
        due={depositDue}
        received={summary.depositRub}
        locked={locked}
        onDirty={setDepositDirty}
        onConfirm={receive}
      />
    </div>
  );
}

function PaymentColumn({
  kind,
  due,
  price,
  received,
  invoicePayment,
  locked: paymentLocked,
  onDirty,
  onConfirm,
}: {
  kind: ReceiptKind;
  due: string | null;
  price?: string;
  received: string;
  invoicePayment?: RentPaymentProgress;
  locked: boolean;
  onDirty: (dirty: boolean) => void;
  onConfirm: (kind: ReceiptKind, cashRub: bigint, bankRub: bigint, onConfirmed: () => void) => void;
}) {
  const [enabled, setEnabled] = useState({ cash: true, bank: false });
  const [tender, setTender] = useState<Partial<Record<Method, string>>>({});
  const [rentConfirmed, setRentConfirmed] = useState(false);
  const [editingRent, setEditingRent] = useState(false);
  const isRent = kind === 'rent_payment';
  const title = isRent ? 'Аренда' : 'Залог';
  const Icon = isRent ? CalendarOutlined : SafetyOutlined;
  const payable = price ?? due;
  const remaining = due ?? '0';
  const remainingRub = BigInt(remaining);
  const canReceive = !paymentLocked && remainingRub > 0n;
  const rentHasReceipt = isRent && (rentConfirmed || BigInt(received) > 0n);
  const locked = !canReceive || (rentHasReceipt && !editingRent);
  const defaultAmount = rentHasReceipt ? '0' : remaining;
  const tenderValues = {
    cash: enabled.cash ? (tender.cash ?? defaultAmount) : '0',
    bank: enabled.bank ? (tender.bank ?? (enabled.cash ? '0' : defaultAmount)) : '0',
  };
  const cash = parseRub(tenderValues.cash);
  const bank = parseRub(tenderValues.bank);
  const total = cash === undefined || bank === undefined ? undefined : cash + bank;
  const validAmounts = bank !== undefined && total !== undefined && total <= maxRub;
  const amountToPost = isRent && total !== undefined && total < remainingRub ? total : remainingRub;
  const canConfirm =
    validAmounts && amountToPost > 0n && bank <= amountToPost && total >= amountToPost;
  const change = canConfirm ? total - amountToPost : 0n;
  const dirty = !enabled.cash || enabled.bank || Object.keys(tender).length > 0;
  useEffect(() => onDirty(dirty), [dirty, onDirty]);

  let validationMessage: string | undefined;
  if (!locked && (dirty || remainingRub !== 0n)) {
    if (!validAmounts) validationMessage = 'Укажите допустимые суммы в рублях.';
    else if (bank > remainingRub) validationMessage = 'Сумма по карте превышает остаток к оплате.';
    else if (!isRent && total < remainingRub)
      validationMessage = 'Не хватает ' + rub((remainingRub - total).toString());
  }

  function resetForm() {
    setEnabled({ cash: true, bank: false });
    setTender({});
    setEditingRent(false);
  }

  function handleConfirm() {
    if (!canConfirm || locked) return;
    onConfirm(kind, amountToPost - bank, bank, () => {
      if (isRent) setRentConfirmed(true);
      resetForm();
    });
  }

  return (
    <section
      className="checkout-payment-column"
      aria-label={title}
      data-checkout-target={isRent ? 'rent' : 'deposit'}
      tabIndex={-1}
    >
      {invoicePayment ? (
        <div className="checkout-payment-summary checkout-invoice-payment-summary">
          <RentPaymentSummary payment={invoicePayment} />
        </div>
      ) : (
        <div className="checkout-payment-summary">
          <Icon aria-hidden="true" />
          <div>
            <h3>{title}</h3>
            <dl className="checkout-payment-totals">
              <div>
                <dt>К оплате</dt>
                <dd>{payable === null ? 'Сумма не указана' : rub(payable)}</dd>
              </div>
              <div>
                <dt>{isRent ? 'Оплачено' : 'Получено'}</dt>
                <dd>{rub(received)}</dd>
              </div>
              {isRent && (
                <div>
                  <dt>Осталось</dt>
                  <dd>{rub(remaining)}</dd>
                </div>
              )}
            </dl>
          </div>
        </div>
      )}
      <div className="checkout-payment-form">
        <fieldset className="checkout-payment-methods">
          <legend>{editingRent ? 'Способ доплаты' : 'Способ оплаты'}</legend>
          {paymentMethods.map(({ method, label, Icon }) => {
            const unavailable = method === 'bank' && !isRent;
            return (
              <div
                key={method}
                className="checkout-payment-method"
                title={unavailable ? 'Залог принимается наличными' : undefined}
              >
                <Checkbox
                  checked={enabled[method]}
                  disabled={locked || unavailable}
                  onChange={(event) => setEnabled({ ...enabled, [method]: event.target.checked })}
                >
                  <Icon aria-hidden="true" />
                  {label}
                </Checkbox>
                <Input
                  aria-label={title + ' ' + label.toLowerCase() + ', ₽'}
                  inputMode="numeric"
                  maxLength={19}
                  suffix="₽"
                  value={tenderValues[method]}
                  disabled={locked || unavailable || !enabled[method]}
                  onChange={(event) => setTender({ ...tender, [method]: event.target.value })}
                />
              </div>
            );
          })}
        </fieldset>
        <dl className="checkout-payment-totals checkout-payment-calculation" aria-live="polite">
          <div>
            <dt>Получено</dt>
            <dd>{rub(total !== undefined && total <= maxRub ? total.toString() : undefined)}</dd>
          </div>
          <div>
            <dt>Сдача</dt>
            <dd className={change > 0n ? 'checkout-payment-change' : undefined}>
              {rub(change.toString())}
            </dd>
          </div>
        </dl>
        {validationMessage && <span className="checkout-payment-error">{validationMessage}</span>}
        <Button type="primary" disabled={locked || !canConfirm} onClick={handleConfirm}>
          {isRent ? 'Подтвердить оплату аренды' : 'Подтвердить получение залога'}
        </Button>
        {rentHasReceipt && remainingRub > 0n && (
          <Button
            icon={editingRent ? undefined : <EditOutlined aria-hidden="true" />}
            disabled={!canReceive}
            onClick={editingRent ? resetForm : () => setEditingRent(true)}
          >
            {editingRent ? 'Отменить доплату' : 'Редактировать'}
          </Button>
        )}
      </div>
    </section>
  );
}
