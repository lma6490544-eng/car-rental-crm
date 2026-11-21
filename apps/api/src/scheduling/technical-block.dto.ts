import { z } from 'zod';
import { id, period, reason } from './booking.dto';

export const technicalInput = z
  .object({
    vehicleId: id,
    ...period,
    reason,
    conflictsToken: z.string().optional(),
    displaceBookings: z.array(z.object({ id, expectedVersion: id }).strict()).optional(),
    expectedVersion: id.optional(),
  })
  .strict()
  .refine((v) => Date.parse(v.endAt) > Date.parse(v.startAt), 'Период должен быть непустым.');

export type TechnicalBlockInput = z.infer<typeof technicalInput>;
