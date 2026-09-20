/**
 * Enumerations - §5.6.2 (Prisma schema, authoritative) plus the protocol-only
 * enums from §5.3 and §5.4. Never duplicate these anywhere else in the repo.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Identity & roles
// ---------------------------------------------------------------------------

export const ROLES = ['OWNER', 'DRIVER', 'ADMIN', 'GUEST'] as const;
export const RoleSchema = z.enum(ROLES);
export type Role = z.infer<typeof RoleSchema>;

// ---------------------------------------------------------------------------
// Bikes & devices
// ---------------------------------------------------------------------------

export const IGNITION_STATES = ['ON', 'OFF', 'UNKNOWN'] as const;
export const IgnitionStateSchema = z.enum(IGNITION_STATES);
export type IgnitionState = z.infer<typeof IgnitionStateSchema>;

export const BIKE_STATUSES = ['AVAILABLE', 'RENTED', 'MAINTENANCE', 'INACTIVE'] as const;
export const BikeStatusSchema = z.enum(BIKE_STATUSES);
export type BikeStatus = z.infer<typeof BikeStatusSchema>;

/** §5.6.5 "Online state" - derived from lastSeenAt, never stored. */
export const DEVICE_ONLINE_STATES = ['ONLINE', 'STALE', 'OFFLINE'] as const;
export const DeviceOnlineStateSchema = z.enum(DEVICE_ONLINE_STATES);
export type DeviceOnlineState = z.infer<typeof DeviceOnlineStateSchema>;

// ---------------------------------------------------------------------------
// Rentals
// ---------------------------------------------------------------------------

export const RENTAL_STATES = ['PENDING_SYNC', 'ACTIVE', 'ENDING_SYNC', 'ENDED', 'CANCELLED'] as const;
export const RentalStateSchema = z.enum(RENTAL_STATES);
export type RentalState = z.infer<typeof RentalStateSchema>;

/** States that count as "open" for the one-open-rental invariant (FR-RENT-02, §5.6.3). */
export const OPEN_RENTAL_STATES = ['PENDING_SYNC', 'ACTIVE', 'ENDING_SYNC'] as const;
export type OpenRentalState = (typeof OPEN_RENTAL_STATES)[number];

// ---------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------

export const INCIDENT_TYPES = [
  'POSSIBLE_COLLISION',
  'POSSIBLE_LOW_SPEED_RIDER_DROP',
  'POSSIBLE_ROLLOVER',
  'MANUAL_SOS',
  'PARKED_BIKE_FALL',
  'POSSIBLE_TOWING',
  'POSSIBLE_TAMPERING',
  'DEVICE_OFFLINE_DURING_RENTAL',
  'POSSIBLE_POTHOLE',
  'POSSIBLE_DANGEROUS_CORNERING',
] as const;
export const IncidentTypeSchema = z.enum(INCIDENT_TYPES);
export type IncidentType = z.infer<typeof IncidentTypeSchema>;

export const INCIDENT_CATEGORIES = ['EMERGENCY', 'SECURITY', 'INFO'] as const;
export const IncidentCategorySchema = z.enum(INCIDENT_CATEGORIES);
export type IncidentCategory = z.infer<typeof IncidentCategorySchema>;

export const INCIDENT_STATES = [
  'OPEN',
  'AWAITING_RESPONSE',
  'RESOLVED_SAFE',
  'ESCALATED',
  'CLOSED',
  'INFO_RECORDED',
] as const;
export const IncidentStateSchema = z.enum(INCIDENT_STATES);
export type IncidentState = z.infer<typeof IncidentStateSchema>;

export const DECISIONS = ['NOT_APPLICABLE', 'PENDING', 'SAFE', 'HELP', 'TIMEOUT', 'OFFLINE_FALLBACK'] as const;
export const DecisionSchema = z.enum(DECISIONS);
export type Decision = z.infer<typeof DecisionSchema>;

export const DECISION_SOURCES = ['APP', 'DEVICE_BUTTON', 'SERVER_TIMER', 'DEVICE_OFFLINE_TIMER'] as const;
export const DecisionSourceSchema = z.enum(DECISION_SOURCES);
export type DecisionSource = z.infer<typeof DecisionSourceSchema>;

/** §5.6.5 severity label. MANUAL_SOS uses "SOS" with a null score. */
export const SEVERITY_LABELS = ['LOW', 'MODERATE', 'HIGH', 'SOS'] as const;
export const SeverityLabelSchema = z.enum(SEVERITY_LABELS);
export type SeverityLabel = z.infer<typeof SeverityLabelSchema>;

// ---------------------------------------------------------------------------
// Location
// ---------------------------------------------------------------------------

export const LOCATION_KINDS = ['LIVE', 'LAST_KNOWN', 'UNAVAILABLE'] as const;
export const LocationKindSchema = z.enum(LOCATION_KINDS);
export type LocationKind = z.infer<typeof LocationKindSchema>;

export const LOCATION_SOURCES = ['GPS', 'DEMO'] as const;
export const LocationSourceSchema = z.enum(LOCATION_SOURCES);
export type LocationSource = z.infer<typeof LocationSourceSchema>;

/** §5.3.1 device clock provenance. */
export const TIME_SOURCES = ['GPS', 'SERVER_SYNC', 'UNSYNCED'] as const;
export const TimeSourceSchema = z.enum(TIME_SOURCES);
export type TimeSource = z.infer<typeof TimeSourceSchema>;

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

export const PHOTO_STATUSES = ['NOT_REQUESTED', 'PENDING', 'UPLOADING', 'AVAILABLE', 'FAILED'] as const;
export const PhotoStatusSchema = z.enum(PHOTO_STATUSES);
export type PhotoStatus = z.infer<typeof PhotoStatusSchema>;

export const IMAGE_STATES = ['RESERVED', 'UPLOADING', 'COMPLETE', 'FAILED'] as const;
export const ImageStateSchema = z.enum(IMAGE_STATES);
export type ImageState = z.infer<typeof ImageStateSchema>;

// ---------------------------------------------------------------------------
// Responses & notifications
// ---------------------------------------------------------------------------

export const RESPONSE_CHOICES = ['SAFE', 'HELP'] as const;
export const ResponseChoiceSchema = z.enum(RESPONSE_CHOICES);
export type ResponseChoice = z.infer<typeof ResponseChoiceSchema>;

export const RESPONSE_SOURCES = ['APP', 'DEVICE_BUTTON'] as const;
export const ResponseSourceSchema = z.enum(RESPONSE_SOURCES);
export type ResponseSource = z.infer<typeof ResponseSourceSchema>;

export const NOTIFICATION_KINDS = [
  'OWNER_SMS',
  'CONTACT_SMS',
  'CONTACT_CALL',
  'DRIVER_PROMPT',
  'OWNER_PUSH',
] as const;
export const NotificationKindSchema = z.enum(NOTIFICATION_KINDS);
export type NotificationKind = z.infer<typeof NotificationKindSchema>;

export const NOTIFICATION_STATES = [
  'REQUESTED',
  'QUEUED',
  'AT_SUBMITTED',
  'NETWORK_CONFIRMED',
  'PROVIDER_ACCEPTED',
  'CLIENT_RECEIVED',
  'RESPONDED',
  'FAILED',
  'OUTCOME_UNKNOWN',
] as const;
export const NotificationStateSchema = z.enum(NOTIFICATION_STATES);
export type NotificationState = z.infer<typeof NotificationStateSchema>;

/** §5.3.7 - the subset of states a device may report for an SMS attempt. */
export const DEVICE_NOTIFICATION_STATES = [
  'QUEUED',
  'AT_SUBMITTED',
  'NETWORK_CONFIRMED',
  'FAILED',
  'OUTCOME_UNKNOWN',
] as const;
export const DeviceNotificationStateSchema = z.enum(DEVICE_NOTIFICATION_STATES);
export type DeviceNotificationState = z.infer<typeof DeviceNotificationStateSchema>;

// ---------------------------------------------------------------------------
// Device commands
// ---------------------------------------------------------------------------

export const COMMAND_TYPES = [
  'SET_ASSIGNMENT',
  'CLEAR_ASSIGNMENT',
  'SET_CONFIG',
  'INCIDENT_DECISION',
  'DEMO_TRIGGER',
] as const;
export const CommandTypeSchema = z.enum(COMMAND_TYPES);
export type CommandType = z.infer<typeof CommandTypeSchema>;

export const COMMAND_STATUSES = ['QUEUED', 'DELIVERED', 'ACKED', 'REJECTED', 'EXPIRED'] as const;
export const CommandStatusSchema = z.enum(COMMAND_STATUSES);
export type CommandStatus = z.infer<typeof CommandStatusSchema>;

export const COMMAND_ACK_RESULTS = ['APPLIED', 'REJECTED'] as const;
export const CommandAckResultSchema = z.enum(COMMAND_ACK_RESULTS);
export type CommandAckResult = z.infer<typeof CommandAckResultSchema>;

/** §5.3.4 DEMO_TRIGGER scenarios. */
export const DEMO_SCENARIOS = ['TOWING', 'CORNERING', 'POTHOLE', 'PARKED_FALL', 'TAMPER'] as const;
export const DemoScenarioSchema = z.enum(DEMO_SCENARIOS);
export type DemoScenario = z.infer<typeof DemoScenarioSchema>;

// ---------------------------------------------------------------------------
// Error codes - §5.4.1. No other code may ever be returned.
// ---------------------------------------------------------------------------

export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHORIZED',
  'TOKEN_EXPIRED',
  'BAD_SIGNATURE',
  'STALE_TIMESTAMP',
  'REPLAYED_NONCE',
  'DEVICE_REVOKED',
  'FORBIDDEN',
  'READ_ONLY_GUEST',
  'NOT_FOUND',
  'CONFLICT',
  'EMAIL_TAKEN',
  'PHONE_TAKEN',
  'RENTAL_ACTIVE_EXISTS',
  'DRIVER_BUSY',
  'NO_EMERGENCY_CONTACT',
  'DEVICE_NOT_PAIRED',
  'DEVICE_ALREADY_PAIRED',
  'TOO_LATE',
  'ALREADY_DECIDED',
  'PAYLOAD_TOO_LARGE',
  'RATE_LIMITED',
  'INTERNAL',
] as const;
export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/** The HTTP status each §5.4.1 code is returned with. */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHORIZED: 401,
  TOKEN_EXPIRED: 401,
  BAD_SIGNATURE: 401,
  STALE_TIMESTAMP: 401,
  REPLAYED_NONCE: 401,
  DEVICE_REVOKED: 401,
  FORBIDDEN: 403,
  READ_ONLY_GUEST: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  EMAIL_TAKEN: 409,
  PHONE_TAKEN: 409,
  RENTAL_ACTIVE_EXISTS: 409,
  DRIVER_BUSY: 409,
  NO_EMERGENCY_CONTACT: 409,
  DEVICE_NOT_PAIRED: 409,
  DEVICE_ALREADY_PAIRED: 409,
  TOO_LATE: 409,
  ALREADY_DECIDED: 409,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};
