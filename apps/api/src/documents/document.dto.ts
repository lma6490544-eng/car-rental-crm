import { z } from 'zod';

export const fileId = z.uuid();
export const version = z.number().int().min(1).max(2147483647);
export const inspectionKind = z.enum(['pickup', 'check_in']);
export const inspectionInput = z
  .object({
    expectedBookingVersion: version,
    expectedRevision: version.or(z.literal(0)),
    workId: version.optional(),
    mileageKm: z.number().int().min(0).max(2147483647),
    fuelEighths: z.number().int().min(0).max(8),
    noDamage: z.boolean(),
    damageNotes: z.string().trim().max(4000),
    specialNotes: z.string().trim().max(4000),
    photoIds: z
      .array(fileId)
      .max(20)
      .refine((ids) => new Set(ids).size === ids.length),
    acknowledgeNoPhotos: z.boolean(),
  })
  .strict()
  .refine((input) => input.noDamage === !input.damageNotes, {
    path: ['damageNotes'],
    message: 'Опишите повреждения или явно отметьте их отсутствие.',
  });

const required = (max: number) => z.string().trim().min(1).max(max);
const identity = z
  .object({
    fullName: required(160),
    passport: required(500),
    address: required(500),
    phone: required(40),
    license: required(100),
  })
  .strict();

export const contractInput = z
  .object({
    expectedBookingVersion: version,
    expectedCustomerVersion: version,
    expectedContractVersionId: version.nullable(),
    additionalDriver: identity.nullable(),
    securityDepositRub: z.string().regex(/^(0|[1-9]\d{0,17})$/),
  })
  .strict();
export const signInput = z
  .object({
    expectedBookingVersion: version,
    confirmed: z.literal(true),
  })
  .strict();
export const lessorInput = z
  .object({
    name: required(200),
    requisites: required(1600),
    signer: required(160),
    authority: required(500),
  })
  .strict();

export type InspectionKind = z.infer<typeof inspectionKind>;
export type InspectionInput = z.infer<typeof inspectionInput>;
export type ContractInput = z.infer<typeof contractInput>;
export type Lessor = z.infer<typeof lessorInput>;

export const checkoutInput = z.object({ expectedBookingVersion: version }).strict();
export const stopCheckoutInput = checkoutInput.extend({
  expectedStartedAt: z.string().min(1).max(64),
  confirmed: z.boolean(),
});
export type StopCheckoutInput = z.infer<typeof stopCheckoutInput>;
export const issueInput = checkoutInput.extend({
  contractVersionId: version,
  actVersionId: version,
});
export type IssueInput = z.infer<typeof issueInput>;
export const startInspectionInput = checkoutInput.extend({ replaceWorkId: version.optional() });
export const cancelInspectionInput = checkoutInput.extend({ workId: version });
export const actInput = checkoutInput.extend({ inspectionRevisionId: version });
export const signActInput = actInput.extend({
  actVersionId: version,
  confirmed: z.literal(true),
});
