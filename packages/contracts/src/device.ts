/**
 * §5.3 Device protocol (`/d/v1`).
 *
 * Auth is QUERY-STRING based (`?dev=&ts=&nonce=&sig=`) per Appendix E.1.2,
 * which overrides the header scheme in §5.3.2. The canonical string is:
 *
 *   METHOD \n path \n dev \n ts \n nonce \n sha256hex(body)
 *
 * `path` excludes the query string entirely.
 */
import { z } from 'zod';
import {
  CommandAckResultSchema,
  CommandTypeSchema,
  DemoScenarioSchema,
  DeviceNotificationStateSchema,
  DecisionSchema,
  IgnitionStateSchema,
  IncidentTypeSchema,
  LocationKindSchema,
  LocationSourceSchema,
  NotificationKindSchema,
  PhotoStatusSchema,
  ResponseChoiceSchema,
  TimeSourceSchema,
} from './enums.js';
import { DeviceCodeSchema, IsoDateTimeSchema, PhoneE164Schema, UuidSchema } from './common.js';

/** Every `/d/v1` JSON body carries `"schema": 1` (§5.3.1). */
export const DEVICE_SCHEMA_VERSION = 1;
export const SchemaVersionSchema = z.literal(DEVICE_SCHEMA_VERSION);

// ---------------------------------------------------------------------------
// Query-string auth (Appendix E.1.2)
// ---------------------------------------------------------------------------

export const DeviceAuthQuerySchema = z.object({
  dev: DeviceCodeSchema,
  ts: z.coerce.number().int().positive(),
  nonce: z
    .string()
    .trim()
    .regex(/^[0-9a-fA-F]{6,32}$/, 'nonce must be hex'),
  sig: z
    .string()
    .trim()
    .regex(/^[0-9a-fA-F]{64}$/, 'sig must be 64 hex characters'),
});
export type DeviceAuthQuery = z.infer<typeof DeviceAuthQuerySchema>;

/** §5.3.2: |now - ts| <= 300 s, and the nonce is unseen for 10 minutes. */
export const DEVICE_TIMESTAMP_WINDOW_SEC = 300;
export const DEVICE_NONCE_TTL_SEC = 600;

/** §5.4.10: "60/min per device (burst 20)" - the burst is Nginx's job. */
export const DEVICE_RATE_LIMIT_PER_MIN = 60;

/** §5.7.4: Nginx caps `/d/` at 32 KB; the API enforces the same, in depth. */
export const DEVICE_BODY_LIMIT_BYTES = 32 * 1024;

// ---------------------------------------------------------------------------
// §5.3.9 Device configuration object
// ---------------------------------------------------------------------------

export const DeviceConfigSchema = z.object({
  configVersion: z.number().int().nonnegative(),
  telemetryOnSec: z.number().int().min(5).max(600),
  telemetryOffSec: z.number().int().min(5).max(3600),
  controlPollSec: z.number().int().min(1).max(60),
  fallConfirmSec: z.number().int().min(1).max(120),
  responseWindowSec: z.number().int().min(10).max(600),
  offlineFallbackSec: z.number().int().min(10).max(600),
  deadlineGraceSec: z.number().int().min(0).max(120),
  fallAngleDeg: z.number().min(10).max(90),
  recoverAngleDeg: z.number().min(5).max(90),
  rearmUprightSec: z.number().int().min(1).max(60),
  impactG: z.number().min(0.5).max(16),
  rotationDps: z.number().min(10).max(2000),
  collisionSpeedKph: z.number().min(0).max(200),
  potholeG: z.number().min(0.5).max(16),
  cornerLeanDeg: z.number().min(5).max(90),
  cornerMinSpeedKph: z.number().min(0).max(200),
  towMinSpeedKph: z.number().min(0).max(200),
  towMinSec: z.number().int().min(1).max(3600),
  towMinDistanceM: z.number().min(1).max(10000),
  autoCallContact: z.boolean(),
  demoMode: z.boolean(),
});
export type DeviceConfig = z.infer<typeof DeviceConfigSchema>;

/** §5.3.9 defaults - the starting values shipped to a freshly provisioned device. */
export const DEFAULT_DEVICE_CONFIG: DeviceConfig = {
  configVersion: 1,
  telemetryOnSec: 10,
  telemetryOffSec: 60,
  controlPollSec: 3,
  fallConfirmSec: 10,
  responseWindowSec: 60,
  offlineFallbackSec: 60,
  deadlineGraceSec: 15,
  fallAngleDeg: 60,
  recoverAngleDeg: 40,
  rearmUprightSec: 5,
  impactG: 2.5,
  rotationDps: 150,
  collisionSpeedKph: 20,
  potholeG: 1.8,
  cornerLeanDeg: 35,
  cornerMinSpeedKph: 15,
  towMinSpeedKph: 5,
  towMinSec: 30,
  towMinDistanceM: 50,
  autoCallContact: false,
  demoMode: false,
};

/**
 * §5.3.9 + FR-DEV-05: the two agreed safety parameters (S5). An owner may never
 * change them; only an ADMIN may. Keep in sync with the pinned decisions in CLAUDE.md.
 */
export const LOCKED_CONFIG_FIELDS = ['fallConfirmSec', 'responseWindowSec'] as const;
export const LOCKED_CONFIG_VALUES: Record<(typeof LOCKED_CONFIG_FIELDS)[number], number> = {
  fallConfirmSec: 10,
  responseWindowSec: 60,
};

/** The partial config an owner may PUT (§5.4.4) - locked fields excluded. */
export const OwnerDeviceConfigPatchSchema = DeviceConfigSchema.omit({
  configVersion: true,
  fallConfirmSec: true,
  responseWindowSec: true,
}).partial();
export type OwnerDeviceConfigPatch = z.infer<typeof OwnerDeviceConfigPatchSchema>;

// ---------------------------------------------------------------------------
// §5.3.3 Heartbeat / telemetry
// ---------------------------------------------------------------------------

export const GpsFixSchema = z.object({
  t: IsoDateTimeSchema,
  lat: z.number(),
  lon: z.number(),
  spd: z.number().nullable().optional(),
  hdop: z.number().nullable().optional(),
  sat: z.number().int().nullable().optional(),
  valid: z.boolean(),
  src: LocationSourceSchema.default('GPS'),
});
export type GpsFix = z.infer<typeof GpsFixSchema>;

export const IgnitionSampleSchema = z.object({
  state: IgnitionStateSchema,
  t: IsoDateTimeSchema,
});

export const DeviceEventSchema = z.object({
  eventId: UuidSchema,
  type: IncidentTypeSchema,
  t: IsoDateTimeSchema,
  evidence: z.record(z.unknown()).default({}),
  lat: z.number().nullable().optional(),
  lon: z.number().nullable().optional(),
});

/** §5.4.1 DeviceHealthDto, as reported by the device. `batteryV` is always null (M10). */
export const DeviceHealthSchema = z.object({
  csq: z.number().int().nullable(),
  gprs: z.boolean(),
  gpsFix: z.boolean(),
  sats: z.number().int().nullable(),
  hdop: z.number().nullable(),
  cameraLink: z.boolean(),
  batteryV: z.null(),
  freeHeap: z.number().int().nullable(),
  uptimeS: z.number().int().nullable(),
  queuedJobs: z.number().int().nullable(),
  demoMode: z.boolean(),
  resetReason: z.string().nullable().optional(),
});
export type DeviceHealth = z.infer<typeof DeviceHealthSchema>;

/** §5.3.3 limits: at most 10 fixes and 5 events per heartbeat. */
export const HEARTBEAT_MAX_FIXES = 10;
export const HEARTBEAT_MAX_EVENTS = 5;

export const HeartbeatRequestSchema = z.object({
  schema: SchemaVersionSchema,
  deviceTime: IsoDateTimeSchema,
  timeSource: TimeSourceSchema,
  fw: z.string().max(32).nullable().optional(),
  assignmentVersion: z.number().int().nullable().optional(),
  configVersion: z.number().int().nonnegative(),
  ignition: z.object({ state: IgnitionStateSchema, changedAt: IsoDateTimeSchema.nullable() }),
  ignitionEvents: z.array(IgnitionSampleSchema).max(20).default([]),
  fixes: z.array(GpsFixSchema).max(HEARTBEAT_MAX_FIXES).default([]),
  events: z.array(DeviceEventSchema).max(HEARTBEAT_MAX_EVENTS).default([]),
  health: DeviceHealthSchema,
  state: z.object({
    mode: z.string().max(32),
    activeEventId: UuidSchema.nullable(),
  }),
});
export type HeartbeatRequest = z.infer<typeof HeartbeatRequestSchema>;

// ---------------------------------------------------------------------------
// §5.3.4 Commands (piggybacked on every device response)
// ---------------------------------------------------------------------------

/** The rental snapshot the device persists in NVS. Taken from the rental row (§5.3.5). */
export const SetAssignmentPayloadSchema = z.object({
  rentalId: UuidSchema,
  assignmentVersion: z.number().int(),
  bikeLabel: z.string(),
  ownerPhone: PhoneE164Schema,
  driverName: z.string(),
  driverPhone: PhoneE164Schema.nullable(),
  contactName: z.string(),
  contactPhone: PhoneE164Schema,
});
export type SetAssignmentPayload = z.infer<typeof SetAssignmentPayloadSchema>;

export const ClearAssignmentPayloadSchema = z.object({
  rentalId: UuidSchema,
  assignmentVersion: z.number().int(),
});
export type ClearAssignmentPayload = z.infer<typeof ClearAssignmentPayloadSchema>;

export const SetConfigPayloadSchema = DeviceConfigSchema;

export const IncidentDecisionPayloadSchema = z.object({
  eventId: UuidSchema,
  decision: z.enum(['SAFE', 'HELP', 'TIMEOUT']),
});

export const DemoTriggerPayloadSchema = z.object({ scenario: DemoScenarioSchema });

export const DeviceCommandSchema = z.object({
  id: UuidSchema,
  type: CommandTypeSchema,
  payload: z.record(z.unknown()),
});
export type DeviceCommandDto = z.infer<typeof DeviceCommandSchema>;

/** Every device endpoint returns serverTime, configVersion and commands (§5.3.3). */
export const DeviceEnvelopeSchema = z.object({
  serverTime: IsoDateTimeSchema,
  configVersion: z.number().int(),
  commands: z.array(DeviceCommandSchema),
});

export const HeartbeatResponseSchema = DeviceEnvelopeSchema.extend({
  nextIntervalSec: z.number().int().positive(),
});
export type HeartbeatResponse = z.infer<typeof HeartbeatResponseSchema>;

export const CommandAckRequestSchema = z.object({
  result: CommandAckResultSchema,
  assignmentVersion: z.number().int().optional(),
  configVersion: z.number().int().optional(),
  reason: z.string().max(200).optional(),
});
export type CommandAckRequest = z.infer<typeof CommandAckRequestSchema>;

/** §5.3.4 command expiry: 24 h generally, 1 h for INCIDENT_DECISION. */
export const COMMAND_TTL_SEC = 24 * 60 * 60;
export const INCIDENT_DECISION_COMMAND_TTL_SEC = 60 * 60;

// ---------------------------------------------------------------------------
// §5.3.5 Incident upsert
// ---------------------------------------------------------------------------

export const SensorWindowSchema = z.object({
  hz: z.number().positive(),
  t0: IsoDateTimeSchema,
  a: z.array(z.number()),
  g: z.array(z.number()),
  tilt: z.array(z.number()),
  spd: z.array(z.number()),
});
export type SensorWindow = z.infer<typeof SensorWindowSchema>;

export const IncidentEvidenceSchema = z
  .object({
    fallenDurationMs: z.number().nullable().optional(),
    peakAccelerationG: z.number().nullable().optional(),
    peakRotationDps: z.number().nullable().optional(),
    maxTiltDeg: z.number().nullable().optional(),
    durationMs: z.number().nullable().optional(),
    simulated: z.boolean().default(false),
  })
  .passthrough();
export type IncidentEvidence = z.infer<typeof IncidentEvidenceSchema>;

export const IncidentLocationSchema = z.object({
  kind: LocationKindSchema,
  lat: z.number().nullable(),
  lon: z.number().nullable(),
  fixAt: IsoDateTimeSchema.nullable(),
  ageSecondsAtEvent: z.number().int().nullable(),
  src: LocationSourceSchema.nullable(),
});

/** §5.3.5 - the device may have already decided (offline fallback / local button). */
export const LocalDecisionSchema = z.object({
  decision: z.enum(['OFFLINE_FALLBACK', 'SAFE', 'HELP']),
  source: z.enum(['DEVICE_BUTTON', 'DEVICE_OFFLINE_TIMER']),
  decidedAt: IsoDateTimeSchema,
});
export type LocalDecision = z.infer<typeof LocalDecisionSchema>;

export const IncidentUpsertRequestSchema = z.object({
  schema: SchemaVersionSchema,
  eventId: UuidSchema,
  rentalId: UuidSchema.nullable(),
  assignmentVersion: z.number().int().nullable(),
  type: IncidentTypeSchema,
  occurredAt: IsoDateTimeSchema,
  timeSource: TimeSourceSchema,
  ignition: IgnitionStateSchema,
  preEventSpeedKph: z.number().nullable(),
  evidence: IncidentEvidenceSchema,
  sensorWindow: SensorWindowSchema.nullable().optional(),
  location: IncidentLocationSchema,
  photoStatus: PhotoStatusSchema,
  localDecision: LocalDecisionSchema.nullable().optional(),
  recipients: z
    .object({
      ownerPhoneLast4: z.string().length(4).nullable(),
      contactPhoneLast4: z.string().length(4).nullable(),
    })
    .optional(),
});
export type IncidentUpsertRequest = z.infer<typeof IncidentUpsertRequestSchema>;

export const IncidentUpsertResponseSchema = DeviceEnvelopeSchema.extend({
  incidentId: UuidSchema,
  state: z.string(),
  decision: DecisionSchema,
  serverQuestion: z.boolean(),
  questionSentAt: IsoDateTimeSchema.nullable(),
  responseDeadlineAt: IsoDateTimeSchema.nullable(),
});

// ---------------------------------------------------------------------------
// §5.3.6 Control polling, decision sync and the local button
// ---------------------------------------------------------------------------

export const IncidentControlResponseSchema = z.object({
  serverTime: IsoDateTimeSchema,
  decision: DecisionSchema,
  commandId: UuidSchema.nullable(),
  responseDeadlineAt: IsoDateTimeSchema.nullable(),
  decidedAt: IsoDateTimeSchema.nullable(),
});

export const IncidentControlAckRequestSchema = z.object({
  applied: z.boolean(),
  localState: z.string().max(32),
});

export const LocalResponseRequestSchema = z.object({
  choice: ResponseChoiceSchema,
  deviceTime: IsoDateTimeSchema,
  idempotencyKey: z.string().min(8).max(100),
});

export const LocalResponseResultSchema = z.object({
  accepted: z.boolean(),
  decision: DecisionSchema,
  reason: z.string().optional(),
});

// ---------------------------------------------------------------------------
// §5.3.7 Notification reporting
// ---------------------------------------------------------------------------

export const DeviceNotificationReportSchema = z.object({
  schema: SchemaVersionSchema,
  kind: NotificationKindSchema,
  attemptNo: z.number().int().min(1).max(10),
  state: DeviceNotificationStateSchema,
  detail: z.string().max(200).nullable().optional(),
  deviceTime: IsoDateTimeSchema,
});
export type DeviceNotificationReport = z.infer<typeof DeviceNotificationReportSchema>;

// ---------------------------------------------------------------------------
// §5.3.2 `GET /d/v1/time` (unsigned)
// ---------------------------------------------------------------------------

export const DeviceTimeResponseSchema = z.object({
  serverTime: IsoDateTimeSchema,
  epoch: z.number().int(),
});
