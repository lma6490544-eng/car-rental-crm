import { z } from 'zod';
import { MAX_RUB } from './ledger';

const id = z.number().int().positive().max(2147483647);
const rubPattern = /^(0|[1-9][0-9]{0,18})$/;
const money = z
  .string()
  .regex(rubPattern)
  .refine((v) => !rubPattern.test(v) || BigInt(v) <= MAX_RUB, 'Сумма слишком велика.');
const amount = money.refine(
  (v) => !rubPattern.test(v) || BigInt(v) > 0n,
  'Сумма должна быть больше нуля.',
);
const base = {
  reason: z.string().trim().min(1).max(1000),
  warningToken: z.string().optional(),
  shortfallAcknowledged: z.boolean().optional(),
};
const booking = { customerId: id, bookingId: id, expectedVersion: id };
const source = z
  .object({
    lotId: id,
    bucket: z.enum(['rent', 'deposit', 'credit']),
    fund: z.enum(['operating_cash', 'deposit_pool']).nullable(),
    bookingId: id.nullable(),
    amountRub: amount,
  })
  .strict();
export const financeInput = z.discriminatedUnion('kind', [
  z
    .object({
      ...base,
      ...booking,
      kind: z.literal('rent_payment'),
      amountRub: amount,
      method: z.enum(['cash', 'bank']),
    })
    .strict(),
  z
    .object({
      ...base,
      ...booking,
      kind: z.literal('deposit_receipt'),
      amountRub: amount,
      method: z.literal('cash'),
    })
    .strict(),
  z
    .object({
      ...base,
      ...booking,
      kind: z.literal('to_credit'),
      sources: z.array(source).min(1).max(50),
    })
    .strict(),
  z
    .object({
      ...base,
      ...booking,
      kind: z.literal('credit_use'),
      sources: z.array(source).min(1).max(50),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal('refund'),
      customerId: id,
      bookingId: id.optional(),
      expectedVersion: id.optional(),
      method: z.enum(['cash', 'bank']),
      sources: z.array(source).min(1).max(50),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal('initial'),
      fund: z.enum(['operating_cash', 'deposit_pool']),
      amountRub: money,
    })
    .strict(),
  z
    .object({
      ...base,
      ...booking,
      kind: z.literal('deposit_settlement'),
      expectedDepositRub: amount,
      reserveRub: money,
    })
    .strict(),
  z.object({ ...base, kind: z.literal('reversal'), operationId: id }).strict(),
]);
export type FinanceInput = z.infer<typeof financeInput>;

export const checkoutReceiptInput = z
  .object({
    ...booking,
    kind: z.enum(['rent_payment', 'deposit_receipt']),
    cashRub: money,
    bankRub: money,
    returnDebtRub: amount.optional(),
    reason: base.reason,
  })
  .strict()
  .refine(({ kind, returnDebtRub }) => returnDebtRub === undefined || kind === 'rent_payment', {
    path: ['returnDebtRub'],
    message: 'Итоговый расчёт применяется только к оплате аренды.',
  })
  .refine(({ kind, bankRub }) => kind !== 'deposit_receipt' || bankRub === '0', {
    path: ['bankRub'],
    message: 'Залог принимается наличными.',
  })
  .refine(
    ({ cashRub, bankRub }) => {
      if (!rubPattern.test(cashRub) || !rubPattern.test(bankRub)) return true;
      const total = BigInt(cashRub) + BigInt(bankRub);
      return total > 0n && total <= MAX_RUB;
    },
    { message: 'Укажите допустимую сумму поступления.' },
  );

export type CheckoutReceiptInput = z.infer<typeof checkoutReceiptInput>;

export const invoiceReceiptInput = z
  .object({
    ...booking,
    amountRub: amount,
    expectedCoverageRub: money,
    paidOn: z.iso
      .date()
      .refine(
        (value) => value <= new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' }),
        'Дата поступления не может быть в будущем.',
      ),
    reference: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

export type InvoiceReceiptInput = z.infer<typeof invoiceReceiptInput>;
