import { z } from 'zod';
import { customerInput } from '../catalog/catalog.dto';
import { bookingPricing } from './booking-pricing';
export const id = z.number().int().positive().max(2147483647),
  reason = z.string().trim().min(1).max(1000);
export const target = z
  .object({ type: z.enum(['vehicle', 'model', 'brand', 'equivalence_group']), id })
  .strict();
export const bookingPreview = z
  .object({ target, pricing: bookingPricing, bookingId: id.optional() })
  .strict();
export type PreviewBookingInput = z.infer<typeof bookingPreview>;
export const acceptance = z
  .object({
    token: z.string().regex(/^[a-f0-9]{64}$/),
    reason: z
      .string()
      .trim()
      .max(1000)
      .optional()
      .transform((v) => v || 'Сохранение брони с предупреждением о доступности'),
  })
  .strict()
  .optional();
export const assignVehicle = z
  .object({
    expectedVersion: id,
    reason: z
      .string()
      .trim()
      .max(1000)
      .optional()
      .transform((value) => value || 'Изменение назначения автомобиля'),
    vehicleId: id.nullable(),
    riskAcceptance: acceptance,
  })
  .strict();
export const cancelBooking = z.object({ expectedVersion: id, reason }).strict();
export const period = {
  startAt: z.iso.datetime({ offset: true }),
  endAt: z.iso.datetime({ offset: true }),
};
export const evaluation = z
  .object({ target, ...period, bookingId: id.optional(), vehicleId: id.nullable().optional() })
  .strict()
  .refine((v) => Date.parse(v.endAt) > Date.parse(v.startAt), 'Период должен быть непустым.');
export type EvaluateAvailabilityInput = z.infer<typeof evaluation>;
export const bookingCustomer = z.union([
  z
    .object({ existingId: id, expectedVersion: id.optional(), data: customerInput.optional() })
    .strict()
    .refine((v) => !v.data || !!v.expectedVersion, 'Нужна версия клиента.'),
  z.object({ new: customerInput }).strict(),
]);
export const terms = z
  .object({
    target,
    quoteId: id.optional(),
    pricing: bookingPricing.optional(),
    previewToken: z.string().optional(),
    confirmedOverrides: z.array(z.string()).optional(),
    customer: bookingCustomer.optional(),
    vehicleId: id.nullable().optional(),
    riskAcceptance: acceptance,
    reason,
  })
  .strict();
export const create = terms.extend({ customer: bookingCustomer });
export const change = terms.extend({ expectedVersion: id });

export type BookingTermsInput = z.infer<typeof terms>;
export type CreateBookingInput = z.infer<typeof create>;
export type UpdateBookingInput = z.infer<typeof change>;
export type AssignVehicleInput = z.infer<typeof assignVehicle>;
export type CancelBookingInput = z.infer<typeof cancelBooking>;

export const movePreview = z
  .object({ startAt: z.iso.datetime({ offset: true }), vehicleId: id })
  .strict();
export const moveBooking = z
  .object({
    startAt: z.iso.datetime({ offset: true }),
    vehicleId: id,
    expectedVersion: id,
    availabilityToken: z.string().regex(/^[a-f0-9]{64}$/),
    quoteToken: z.string().optional(),
    reason: z.string().trim().min(1).max(1000).default('Изменение автомобиля или времени брони'),
  })
  .strict();

export type MovePreviewInput = z.infer<typeof movePreview>;
export type MoveBookingInput = z.infer<typeof moveBooking>;
