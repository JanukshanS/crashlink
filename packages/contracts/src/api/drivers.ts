/** §5.4.3 Driver. */
import { z } from 'zod';
import { IsoDateTimeSchema, MaskedPhoneSchema, PhoneE164Schema, UuidSchema } from '../common.js';
import { IgnitionStateSchema, RentalStateSchema, ResponseChoiceSchema } from '../enums.js';
import { LocationDtoSchema } from './shared.js';

export const EmergencyContactDtoSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  phone: PhoneE164Schema,
  relationship: z.string(),
  updatedAt: IsoDateTimeSchema,
});
export type EmergencyContactDto = z.infer<typeof EmergencyContactDtoSchema>;

export const UpsertEmergencyContactRequestSchema = z.object({
  name: z.string().trim().min(2).max(120),
  phone: PhoneE164Schema,
  relationship: z.string().trim().min(2).max(60),
});
export type UpsertEmergencyContactRequest = z.infer<typeof UpsertEmergencyContactRequestSchema>;

/**
 * FR-DRV-04: a contact edited during an open rental applies to the NEXT rental,
 * because the open rental keeps the snapshot taken at assignment (§5.6.4).
 */
export const UpsertEmergencyContactResponseSchema = EmergencyContactDtoSchema.extend({
  appliesTo: z.enum(['CURRENT', 'NEXT_RENTAL']),
});
export type UpsertEmergencyContactResponse = z.infer<typeof UpsertEmergencyContactResponseSchema>;

export const DriverActiveRentalDtoSchema = z.object({
  id: UuidSchema,
  state: RentalStateSchema,
  startedAt: IsoDateTimeSchema.nullable(),
  distanceM: z.number(),
  bike: z.object({
    label: z.string(),
    ignition: z.object({ state: IgnitionStateSchema, changedAt: IsoDateTimeSchema.nullable() }),
    location: LocationDtoSchema,
    deviceOnline: z.string(),
  }),
  ownerName: z.string(),
  ownerPhone: MaskedPhoneSchema,
});

export const DriverActiveRentalResponseSchema = z.object({
  rental: DriverActiveRentalDtoSchema.nullable(),
});

export const PendingQuestionResponseSchema = z.object({
  serverTime: IsoDateTimeSchema,
  question: z
    .object({
      incidentId: UuidSchema,
      type: z.string(),
      label: z.string(),
      occurredAt: IsoDateTimeSchema,
      questionSentAt: IsoDateTimeSchema,
      responseDeadlineAt: IsoDateTimeSchema,
      myResponse: ResponseChoiceSchema.nullable(),
    })
    .nullable(),
});

export const DriverResponseRequestSchema = z.object({
  choice: ResponseChoiceSchema,
  idempotencyKey: UuidSchema,
});

export const DriverResponseResultSchema = z.object({
  accepted: z.boolean(),
  decision: z.string(),
  serverAcceptedAt: IsoDateTimeSchema,
  deviceSync: z.enum(['PENDING', 'SYNCED']),
});

/** §5.4.3 `GET /drivers/lookup?q=` - exact match on phone or email, OWNER only. */
export const DriverLookupQuerySchema = z.object({
  q: z.string().trim().min(3).max(254),
});
export type DriverLookupQuery = z.infer<typeof DriverLookupQuerySchema>;

export const DriverLookupResultSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  phoneMasked: MaskedPhoneSchema.nullable(),
  hasEmergencyContact: z.boolean(),
  busy: z.boolean(),
});
export type DriverLookupResult = z.infer<typeof DriverLookupResultSchema>;
