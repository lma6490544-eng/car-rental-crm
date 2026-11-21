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
  z.object({ ...base, kind: z.literal('reversal'), operationId: id }).strict(),
]);
export type FinanceInput = z.infer<typeof financeInput>;
