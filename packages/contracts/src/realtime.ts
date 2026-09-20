/**
 * §5.5 Realtime events (Socket.IO).
 *
 * The socket is a hint; REST is the truth. On connect the app re-fetches its
 * active queries rather than trusting accumulated event state.
 */
import { z } from 'zod';
import { IsoDateTimeSchema, UuidSchema } from './common.js';
import { DecisionSchema, DeviceOnlineStateSchema, RentalStateSchema } from './enums.js';
import { BikeSummaryDtoSchema, DeviceHealthDtoSchema, IncidentSummaryDtoSchema } from './api/shared.js';
import { NotificationKindSchema, NotificationStateSchema } from './enums.js';

export const SOCKET_PATH = '/socket.io';

/** §5.5 rooms: `user:<id>`, `owner:<id>` for owners, `admin` for admins. */
export const userRoom = (userId: string): string => `user:${userId}`;
export const ownerRoom = (ownerId: string): string => `owner:${ownerId}`;
export const ADMIN_ROOM = 'admin';

export const SOCKET_EVENTS = [
  'bike.updated',
  'device.status',
  'rental.updated',
  'incident.created',
  'incident.updated',
  'incident.question',
  'incident.decision',
  'notification.updated',
] as const;
export type SocketEventName = (typeof SOCKET_EVENTS)[number];

export const BikeUpdatedEventSchema = BikeSummaryDtoSchema;

export const DeviceStatusEventSchema = z.object({
  bikeId: UuidSchema,
  online: DeviceOnlineStateSchema,
  lastSeenAt: IsoDateTimeSchema.nullable(),
  health: DeviceHealthDtoSchema.nullable(),
});

export const RentalUpdatedEventSchema = z.object({
  id: UuidSchema,
  bikeId: UuidSchema,
  state: RentalStateSchema,
  startedAt: IsoDateTimeSchema.nullable(),
  endedAt: IsoDateTimeSchema.nullable(),
  deviceAckAt: IsoDateTimeSchema.nullable(),
});
export type RentalUpdatedEvent = z.infer<typeof RentalUpdatedEventSchema>;

export const IncidentCreatedEventSchema = IncidentSummaryDtoSchema;

export const IncidentUpdatedEventSchema = IncidentSummaryDtoSchema.extend({
  changed: z.array(z.string()),
});

export const IncidentQuestionEventSchema = z.object({
  incidentId: UuidSchema,
  label: z.string(),
  occurredAt: IsoDateTimeSchema,
  questionSentAt: IsoDateTimeSchema,
  responseDeadlineAt: IsoDateTimeSchema,
  serverTime: IsoDateTimeSchema,
});

export const IncidentDecisionEventSchema = z.object({
  incidentId: UuidSchema,
  decision: DecisionSchema,
  decidedAt: IsoDateTimeSchema,
  deviceSynced: z.boolean(),
});

export const NotificationUpdatedEventSchema = z.object({
  incidentId: UuidSchema,
  kind: NotificationKindSchema,
  state: NotificationStateSchema,
});

/** The payload type of each §5.5 event, for a typed client. */
export type SocketEventPayloads = {
  'bike.updated': z.infer<typeof BikeUpdatedEventSchema>;
  'device.status': z.infer<typeof DeviceStatusEventSchema>;
  'rental.updated': z.infer<typeof RentalUpdatedEventSchema>;
  'incident.created': z.infer<typeof IncidentCreatedEventSchema>;
  'incident.updated': z.infer<typeof IncidentUpdatedEventSchema>;
  'incident.question': z.infer<typeof IncidentQuestionEventSchema>;
  'incident.decision': z.infer<typeof IncidentDecisionEventSchema>;
  'notification.updated': z.infer<typeof NotificationUpdatedEventSchema>;
};

/** §5.5 FCM payload shape. No FCM in the MVP (M7), but the contract is fixed. */
export const PushPayloadSchema = z.object({
  type: z.enum(['INCIDENT_QUESTION', 'INCIDENT_CREATED', 'SECURITY_ALERT']),
  incidentId: UuidSchema,
});
