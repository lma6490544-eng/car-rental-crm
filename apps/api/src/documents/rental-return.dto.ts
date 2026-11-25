import { z } from 'zod';
import { rub } from '../pricing/pricing.dto';
import { version } from './document.dto';

const reason = z.string().trim().min(1).max(1000);
const revision = z.number().int().nonnegative().max(2147483647);
const measurements = z.object({
  returnedAt: z.iso.datetime({ offset: true }),
  mileageKm: revision,
  fuelEighths: z.number().int().min(0).max(8),
});
export const returnInspection = measurements
  .extend({
    returnedAt: measurements.shape.returnedAt.nullable(),
    backdateReason: reason.optional(),
    remarks: z.string().trim().max(4000),
    damage: z.boolean(),
    photoException: z.boolean(),
    photoIds: z.array(z.uuid()).max(500),
    excludedPhotoIds: z.array(z.uuid()).max(500).optional(),
    preparation: z.array(z.enum(['wash', 'maintenance', 'repair'])).max(3),
    expectedRevision: revision,
    workId: version.optional(),
  })
  .strict();
export const returnLine = z.enum(['rent', 'surcharge', 'fuel', 'wash']);
export const returnReview = z
  .object({
    expectedRevision: revision,
    wash: z.boolean(),
    adjustments: z
      .array(
        z
          .object({
            line: returnLine,
            amountRub: rub,
            reason,
          })
          .strict(),
      )
      .max(4)
      .refine((rows) => new Set(rows.map((row) => row.line)).size === rows.length),
    token: z.string().optional(),
  })
  .strict();
export const returnCorrection = measurements
  .extend({
    expectedRevision: revision,
    reason,
    removeLines: z.array(returnLine).max(4),
    token: z.string().optional(),
  })
  .strict();
export const returnDamage = z
  .object({
    expectedRevision: revision,
    amountRub: rub.refine((value) => value !== '0', 'Сумма должна быть больше нуля.'),
    reason,
  })
  .strict();

export type ReturnInspection = z.infer<typeof returnInspection>;
export type ReturnReview = z.infer<typeof returnReview>;
export type ReturnCorrection = z.infer<typeof returnCorrection>;
export type ReturnDamage = z.infer<typeof returnDamage>;
export type ReturnLine = z.infer<typeof returnLine>;
