/** §5.4.1 "Shared object shapes (returned by many endpoints)". */
import { z } from 'zod';
import {
  BikeStatusSchema,
  DecisionSchema,
  DeviceOnlineStateSchema,
  IgnitionStateSchema,
  IncidentCategorySchema,
  IncidentStateSchema,
  IncidentTypeSchema,
  LocationKindSchema,
  LocationSourceSchema,
  PhotoStatusSchema,
  RentalStateSchema,
  RoleSchema,
  SeverityLabelSchema,
} from '../enums.js';
import { IsoDateTimeSchema, MaskedPhoneSchema, PhoneE164Schema, UuidSchema } from '../common.js';
import { DeviceHealthSchema } from '../device.js';

export const UserDtoSchema = z.object({
  id: UuidSchema,
  role: RoleSchema,
  name: z.string(),
  email: z.string(),
  phone: PhoneE164Schema.nullable(),
  language: z.string(),
  isDemo: z.boolean(),
  createdAt: IsoDateTimeSchema,
});
export type UserDto = z.infer<typeof UserDtoSchema>;

/** Location with its freshness badge (FR-MON-03). DEMO-sourced fixes always say DEMO. */
export const LocationDtoSchema = z.object({
  kind: LocationKindSchema,
  lat: z.number().nullable(),
  lon: z.number().nullable(),
  fixAt: IsoDateTimeSchema.nullable(),
  ageSec: z.number().int().nullable(),
  speedKph: z.number().nullable(),
  source: LocationSourceSchema.nullable(),
});
export type LocationDto = z.infer<typeof LocationDtoSchema>;

export const BikeDeviceDtoSchema = z.object({
  code: z.string(),
  online: DeviceOnlineStateSchema,
  lastSeenAt: IsoDateTimeSchema.nullable(),
  configVersion: z.number().int(),
  configPending: z.boolean(),
});

export const BikeActiveRentalDtoSchema = z.object({
  id: UuidSchema,
  state: RentalStateSchema,
  driverName: z.string(),
  startedAt: IsoDateTimeSchema.nullable(),
  distanceM: z.number(),
});

export const BikeSummaryDtoSchema = z.object({
  id: UuidSchema,
  label: z.string(),
  plateNo: z.string().nullable(),
  status: BikeStatusSchema,
  device: BikeDeviceDtoSchema.nullable(),
  ignition: z.object({ state: IgnitionStateSchema, changedAt: IsoDateTimeSchema.nullable() }),
  location: LocationDtoSchema,
  activeRental: BikeActiveRentalDtoSchema.nullable(),
  openIncidentCount: z.number().int(),
});
export type BikeSummaryDto = z.infer<typeof BikeSummaryDtoSchema>;

/** §5.4.1 DeviceHealthDto - the device-reported health plus firmware and derived bars. */
export const DeviceHealthDtoSchema = DeviceHealthSchema.omit({ resetReason: true }).extend({
  signalBars: z.number().int().min(0).max(5).nullable(),
  fw: z.string().nullable(),
});
export type DeviceHealthDto = z.infer<typeof DeviceHealthDtoSchema>;

export const SeverityDtoSchema = z.object({
  score: z.number().int().nullable(),
  label: SeverityLabelSchema,
});

export const IncidentSummaryDtoSchema = z.object({
  id: UuidSchema,
  bikeId: UuidSchema,
  bikeLabel: z.string(),
  type: IncidentTypeSchema,
  category: IncidentCategorySchema,
  label: z.string(),
  state: IncidentStateSchema,
  decision: DecisionSchema,
  severity: SeverityDtoSchema,
  occurredAt: IsoDateTimeSchema,
  responseDeadlineAt: IsoDateTimeSchema.nullable(),
  photoStatus: PhotoStatusSchema,
  quarantined: z.boolean(),
  isDemo: z.boolean(),
});
export type IncidentSummaryDto = z.infer<typeof IncidentSummaryDtoSchema>;

/** Phone fields are full for an OWNER and masked for a DRIVER (§5.7.2, §5.7.3). */
export const MaskedOrFullPhoneSchema = z.union([PhoneE164Schema, MaskedPhoneSchema]);
