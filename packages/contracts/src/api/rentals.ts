/** §5.4.5 Rentals. */
import { z } from 'zod';
import { IsoDateTimeSchema, MaskedPhoneSchema, UuidSchema } from '../common.js';
import { RentalStateSchema } from '../enums.js';
import { IncidentSummaryDtoSchema } from './shared.js';

export const CreateRentalRequestSchema = z.object({
  bikeId: UuidSchema,
  driverId: UuidSchema,
  idempotencyKey: UuidSchema,
});
export type CreateRentalRequest = z.infer<typeof CreateRentalRequestSchema>;

/** §5.4.5 `201` - the contact phone is masked even for the owner in this response. */
export const CreateRentalResponseSchema = z.object({
  id: UuidSchema,
  state: RentalStateSchema,
  assignmentVersion: z.number().int(),
  snapshot: z.object({
    driverName: z.string(),
    contactName: z.string(),
    contactPhoneMasked: MaskedPhoneSchema,
  }),
});
export type CreateRentalResponse = z.infer<typeof CreateRentalResponseSchema>;

export const EndRentalRequestSchema = z.object({ idempotencyKey: UuidSchema });

/** FR-RENT-03: only when DEMO_MODE=true; audit-logged and visibly flagged. */
export const ForceActivateRequestSchema = z.object({ confirm: z.literal(true) });

export const RentalStateResponseSchema = z.object({
  state: RentalStateSchema,
  demoOverride: z.boolean().optional(),
});

export const ListRentalsQuerySchema = z.object({
  state: RentalStateSchema.optional(),
  bikeId: UuidSchema.optional(),
});

export const RentalSummaryDtoSchema = z.object({
  id: UuidSchema,
  bikeId: UuidSchema,
  bikeLabel: z.string(),
  driverId: UuidSchema,
  driverName: z.string(),
  state: RentalStateSchema,
  assignmentVersion: z.number().int(),
  demoOverride: z.boolean(),
  requestedAt: IsoDateTimeSchema,
  startedAt: IsoDateTimeSchema.nullable(),
  endedAt: IsoDateTimeSchema.nullable(),
  distanceM: z.number(),
});
export type RentalSummaryDto = z.infer<typeof RentalSummaryDtoSchema>;

/**
 * §5.4.5 `GET /rentals/:id`. The snapshot phones are full for the OWNER and
 * masked for the DRIVER (§5.7.2). Sync timestamps show what the device confirmed.
 */
export const RentalDetailDtoSchema = RentalSummaryDtoSchema.extend({
  snapshot: z.object({
    ownerPhone: z.string(),
    driverName: z.string(),
    driverPhone: z.string().nullable(),
    contactName: z.string(),
    contactPhone: z.string(),
  }),
  sync: z.object({
    requestedAt: IsoDateTimeSchema,
    deviceAckAt: IsoDateTimeSchema.nullable(),
    endRequestedAt: IsoDateTimeSchema.nullable(),
    endedAt: IsoDateTimeSchema.nullable(),
  }),
  incidents: z.array(IncidentSummaryDtoSchema),
});
export type RentalDetailDto = z.infer<typeof RentalDetailDtoSchema>;
