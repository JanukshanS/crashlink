/** §5.4.4 Bikes & devices (owner). */
import { z } from 'zod';
import { DeviceCodeSchema, PairingCodeSchema } from '../common.js';
import { BikeStatusSchema } from '../enums.js';
import { DeviceConfigSchema } from '../device.js';
import { BikeSummaryDtoSchema, DeviceHealthDtoSchema } from './shared.js';

export const CreateBikeRequestSchema = z.object({
  label: z.string().trim().min(1).max(60),
  plateNo: z.string().trim().min(1).max(20).optional(),
});
export type CreateBikeRequest = z.infer<typeof CreateBikeRequestSchema>;

/**
 * §5.4.4: an owner may only move a bike between MAINTENANCE and AVAILABLE.
 * RENTED and INACTIVE are set by the rental lifecycle, never by hand.
 */
export const UpdateBikeRequestSchema = z
  .object({
    label: z.string().trim().min(1).max(60).optional(),
    plateNo: z.string().trim().min(1).max(20).nullable().optional(),
    status: z.enum(['MAINTENANCE', 'AVAILABLE']).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'No fields to update' });
export type UpdateBikeRequest = z.infer<typeof UpdateBikeRequestSchema>;

export const ListBikesQuerySchema = z.object({
  status: BikeStatusSchema.optional(),
});

export const PairDeviceRequestSchema = z.object({
  deviceCode: DeviceCodeSchema,
  pairingCode: PairingCodeSchema,
});
export type PairDeviceRequest = z.infer<typeof PairDeviceRequestSchema>;

/** §5.4.4 `GET /bikes/:id` - summary plus health, config and derived durations. */
export const BikeDetailDtoSchema = BikeSummaryDtoSchema.extend({
  health: DeviceHealthDtoSchema.nullable(),
  config: DeviceConfigSchema.nullable(),
  /** §5.6.5 riding time today (TZ_DISPLAY day), from ignition_events. */
  ridingSecToday: z.number().int(),
  /** Parked time today. Not in the §5.4.4 example; added for the riding/parked chart. */
  parkedSecToday: z.number().int(),
  /** Time today before the first known ignition state - never guessed. */
  unknownSecToday: z.number().int(),
  parkedSinceSec: z.number().int().nullable(),
});
export type BikeDetailDto = z.infer<typeof BikeDetailDtoSchema>;
