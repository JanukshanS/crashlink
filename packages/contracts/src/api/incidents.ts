/** §5.4.6 Incidents & images. */
import { z } from 'zod';
import { IsoDateTimeSchema, MaskedPhoneSchema, UuidSchema } from '../common.js';
import {
  DecisionSchema,
  DecisionSourceSchema,
  IgnitionStateSchema,
  IncidentCategorySchema,
  IncidentStateSchema,
  IncidentTypeSchema,
  NotificationKindSchema,
  NotificationStateSchema,
  PhotoStatusSchema,
  ResponseChoiceSchema,
  ResponseSourceSchema,
  TimeSourceSchema,
} from '../enums.js';
import { IncidentEvidenceSchema, IncidentLocationSchema, SensorWindowSchema } from '../device.js';
import { IncidentSummaryDtoSchema, SeverityDtoSchema } from './shared.js';

export const ListIncidentsQuerySchema = z.object({
  category: IncidentCategorySchema.optional(),
  type: IncidentTypeSchema.optional(),
  state: IncidentStateSchema.optional(),
  bikeId: UuidSchema.optional(),
  from: IsoDateTimeSchema.optional(),
  to: IsoDateTimeSchema.optional(),
});

export const IncidentNotificationDtoSchema = z.object({
  kind: NotificationKindSchema,
  state: NotificationStateSchema,
  recipientMasked: MaskedPhoneSchema.nullable(),
  attempts: z.array(
    z.object({
      attemptNo: z.number().int(),
      state: NotificationStateSchema,
      at: IsoDateTimeSchema,
      detail: z.string().nullable(),
    }),
  ),
});

export const IncidentResponseDtoSchema = z.object({
  choice: ResponseChoiceSchema,
  source: ResponseSourceSchema,
  serverAcceptedAt: IsoDateTimeSchema,
  accepted: z.boolean(),
  reason: z.string().nullable(),
});

export const IncidentTimelineEntrySchema = z.object({
  at: IsoDateTimeSchema,
  event: z.string(),
  text: z.string(),
});

/** §5.6.5 - the severity index is a heuristic and is always shown with its disclaimer. */
export const SEVERITY_DISCLAIMER = 'Heuristic from sensor readings; not a medical assessment.';

export const IncidentDetailDtoSchema = z.object({
  id: UuidSchema,
  type: IncidentTypeSchema,
  label: z.string(),
  category: IncidentCategorySchema,
  state: IncidentStateSchema,
  decision: DecisionSchema,
  decisionSource: DecisionSourceSchema.nullable(),
  decidedAt: IsoDateTimeSchema.nullable(),
  severity: SeverityDtoSchema.extend({ note: z.string() }),
  occurredAt: IsoDateTimeSchema,
  receivedAt: IsoDateTimeSchema,
  timeSource: TimeSourceSchema,
  bike: z.object({ id: UuidSchema, label: z.string() }),
  rental: z
    .object({ id: UuidSchema, driverName: z.string(), driverPhone: z.string().nullable() })
    .nullable(),
  contact: z.object({ name: z.string(), phone: z.string() }).nullable(),
  ignitionAtEvent: IgnitionStateSchema,
  preEventSpeedKph: z.number().nullable(),
  location: IncidentLocationSchema.extend({ source: z.string().nullable() }).partial({ src: true }),
  evidence: IncidentEvidenceSchema,
  sensorWindow: SensorWindowSchema.nullable(),
  question: z
    .object({
      sentAt: IsoDateTimeSchema,
      deadlineAt: IsoDateTimeSchema,
      promptStates: z.array(NotificationStateSchema),
    })
    .nullable(),
  responses: z.array(IncidentResponseDtoSchema),
  notifications: z.array(IncidentNotificationDtoSchema),
  timeline: z.array(IncidentTimelineEntrySchema),
  photo: z
    .object({
      status: PhotoStatusSchema,
      bytes: z.number().int().nullable(),
      sha256: z.string().nullable(),
      integrity: z.enum(['VERIFIED', 'UNVERIFIED', 'MISMATCH']),
    })
    .nullable(),
  integrityHash: z.string().nullable(),
  ownerAckAt: IsoDateTimeSchema.nullable(),
  ownerNote: z.string().nullable(),
  quarantined: z.boolean(),
  isDemo: z.boolean(),
});
export type IncidentDetailDto = z.infer<typeof IncidentDetailDtoSchema>;

export const AcknowledgeIncidentRequestSchema = z.object({
  note: z.string().trim().max(500).optional(),
});

export const IncidentImageUrlResponseSchema = z.object({
  url: z.string(),
  expiresAt: IsoDateTimeSchema,
  sha256: z.string(),
  bytes: z.number().int(),
});

export const IncidentListResponseSchema = z.object({
  items: z.array(IncidentSummaryDtoSchema),
  nextCursor: z.string().nullable(),
});
