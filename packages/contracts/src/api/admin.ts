/** §5.4.8 Admin & demo, and §5.4.7 analytics / dashboard. */
import { z } from 'zod';
import { DeviceCodeSchema, IsoDateTimeSchema, UuidSchema } from '../common.js';
import { IncidentCategorySchema, IncidentTypeSchema, RoleSchema } from '../enums.js';
import { BikeSummaryDtoSchema, IncidentSummaryDtoSchema, UserDtoSchema } from './shared.js';

// ---------------------------------------------------------------------------
// §5.4.8 Device provisioning (FR-DEV-01)
// ---------------------------------------------------------------------------

export const ProvisionDeviceRequestSchema = z
  .object({ code: DeviceCodeSchema.optional() })
  .default({});
export type ProvisionDeviceRequest = z.infer<typeof ProvisionDeviceRequestSchema>;

/**
 * The only response that ever carries the raw secret - it is shown once and
 * then only the AES-256-GCM ciphertext exists (§5.7.1).
 */
export const ProvisionDeviceResponseSchema = z.object({
  id: UuidSchema,
  code: z.string(),
  secret: z.string().regex(/^[0-9a-f]{64}$/),
  pairingCode: z.string(),
  cameraSecret: z.string(),
  apPassword: z.string(),
});
export type ProvisionDeviceResponse = z.infer<typeof ProvisionDeviceResponseSchema>;

export const AdminDeviceDtoSchema = z.object({
  id: UuidSchema,
  code: z.string(),
  paired: z.boolean(),
  bikeLabel: z.string().nullable(),
  lastSeenAt: IsoDateTimeSchema.nullable(),
  fw: z.string().nullable(),
  revoked: z.boolean(),
});
export type AdminDeviceDto = z.infer<typeof AdminDeviceDtoSchema>;

export const ListAdminUsersQuerySchema = z.object({ role: RoleSchema.optional() });

export const AdminUserListResponseSchema = z.object({ items: z.array(UserDtoSchema) });

export const AdminHealthResponseSchema = z.object({
  db: z.string(),
  workers: z.record(
    z.object({ lastRunAt: IsoDateTimeSchema.nullable(), lagMs: z.number().int().nullable() }),
  ),
  staleDevices: z.array(z.string()),
  pendingCommands: z.number().int(),
  version: z.string(),
});

// ---------------------------------------------------------------------------
// §5.4.7 Analytics & dashboard
// ---------------------------------------------------------------------------

export const DashboardResponseSchema = z.object({
  kpis: z.object({
    bikesOnline: z.number().int(),
    bikesTotal: z.number().int(),
    activeRentals: z.number().int(),
    openIncidents: z.number().int(),
    incidentsToday: z.number().int(),
  }),
  openEmergency: IncidentSummaryDtoSchema.nullable(),
  bikes: z.array(BikeSummaryDtoSchema),
  recent: z.array(IncidentSummaryDtoSchema),
});

export const AnalyticsRangeQuerySchema = z.object({
  from: IsoDateTimeSchema.optional(),
  to: IsoDateTimeSchema.optional(),
});

export const IncidentsByTypeResponseSchema = z.object({
  items: z.array(z.object({ type: IncidentTypeSchema, label: z.string(), count: z.number().int() })),
});

export const IncidentsTimeseriesResponseSchema = z.object({
  items: z.array(
    z
      .object({ date: z.string() })
      .catchall(z.number().int())
      .describe('date plus one count per IncidentCategory'),
  ),
});

export const DistanceByBikeResponseSchema = z.object({
  items: z.array(z.object({ bikeId: UuidSchema, label: z.string(), distanceM: z.number() })),
});

export const ResponseOutcomesResponseSchema = z.object({
  SAFE: z.number().int(),
  HELP: z.number().int(),
  TIMEOUT: z.number().int(),
  OFFLINE_FALLBACK: z.number().int(),
  medianResponseSec: z.number().nullable(),
});

export const PotholesResponseSchema = z.object({
  items: z.array(
    z.object({ lat: z.number(), lon: z.number(), at: IsoDateTimeSchema, peakG: z.number().nullable() }),
  ),
});

/**
 * §5.4.9 `GET /health` (root, not under /api/v1). The spec shows the healthy
 * body; `status` is an enum because a probe must not read "ok" when the
 * database check just failed.
 */
export const HealthResponseSchema = z.object({
  status: z.enum(['ok', 'error']),
  db: z.enum(['ok', 'error']),
  time: IsoDateTimeSchema,
});

export const DemoScenarioRequestSchema = z.object({
  deviceCode: DeviceCodeSchema,
  scenario: z.string().min(3).max(64),
});

export { IncidentCategorySchema };
