// Frozen before the Stage 16 move. Do not regenerate from the DTO.
'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
exports.financeInput = void 0;
const zod_1 = require('zod');
const MAX_RUB = 9223372036854775807n;
const id = zod_1.z.number().int().positive().max(2147483647);
const rubPattern = /^(0|[1-9][0-9]{0,18})$/;
const money = zod_1.z
  .string()
  .regex(rubPattern)
  .refine((v) => !rubPattern.test(v) || BigInt(v) <= MAX_RUB, 'Сумма слишком велика.');
const amount = money.refine(
  (v) => !rubPattern.test(v) || BigInt(v) > 0n,
  'Сумма должна быть больше нуля.',
);
const base = {
  reason: zod_1.z.string().trim().min(1).max(1000),
  warningToken: zod_1.z.string().optional(),
  shortfallAcknowledged: zod_1.z.boolean().optional(),
};
const booking = { customerId: id, bookingId: id, expectedVersion: id };
const source = zod_1.z
  .object({
    lotId: id,
    bucket: zod_1.z.enum(['rent', 'deposit', 'credit']),
    fund: zod_1.z.enum(['operating_cash', 'deposit_pool']).nullable(),
    bookingId: id.nullable(),
    amountRub: amount,
  })
  .strict();
exports.financeInput = zod_1.z.discriminatedUnion('kind', [
  zod_1.z
    .object({
      ...base,
      ...booking,
      kind: zod_1.z.literal('rent_payment'),
      amountRub: amount,
      method: zod_1.z.enum(['cash', 'bank']),
    })
    .strict(),
  zod_1.z
    .object({
      ...base,
      ...booking,
      kind: zod_1.z.literal('deposit_receipt'),
      amountRub: amount,
      method: zod_1.z.literal('cash'),
    })
    .strict(),
  zod_1.z
    .object({
      ...base,
      ...booking,
      kind: zod_1.z.literal('to_credit'),
      sources: zod_1.z.array(source).min(1).max(50),
    })
    .strict(),
  zod_1.z
    .object({
      ...base,
      ...booking,
      kind: zod_1.z.literal('credit_use'),
      sources: zod_1.z.array(source).min(1).max(50),
    })
    .strict(),
  zod_1.z
    .object({
      ...base,
      kind: zod_1.z.literal('refund'),
      customerId: id,
      bookingId: id.optional(),
      expectedVersion: id.optional(),
      method: zod_1.z.enum(['cash', 'bank']),
      sources: zod_1.z.array(source).min(1).max(50),
    })
    .strict(),
  zod_1.z
    .object({
      ...base,
      kind: zod_1.z.literal('initial'),
      fund: zod_1.z.enum(['operating_cash', 'deposit_pool']),
      amountRub: money,
    })
    .strict(),
  zod_1.z.object({ ...base, kind: zod_1.z.literal('reversal'), operationId: id }).strict(),
]);
