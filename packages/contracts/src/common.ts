/**
 * Shared primitives: id/phone/timestamp formats, the §5.4.1 error body,
 * pagination envelope, and the display labels from Appendix D.
 */
import { z } from 'zod';
import { ErrorCodeSchema, INCIDENT_TYPES, type IncidentType } from './enums.js';

export const UuidSchema = z.string().uuid();

/** UTC ISO-8601 with Z (§5.4.1). Storage and transport are always UTC. */
export const IsoDateTimeSchema = z.string().datetime({ offset: false });

/** E.164, as stored (§5.7.3). */
export const PhoneE164Schema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{7,14}$/, 'Phone must be E.164, e.g. +94771234567');

/** Masked for lists, logs and driver-facing views (§5.7.3): +94•••••4567. */
export const MaskedPhoneSchema = z.string();

export const EmailSchema = z.string().trim().toLowerCase().email().max(254);

/** FR-AUTH-01: at least 8 characters. */
export const PasswordSchema = z.string().min(8).max(200);

/** §5.3.1 device codes are CL-NNNN. */
export const DeviceCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^CL-\d{4}$/, 'Device code must look like CL-0001');

/** §5.4.4 pairing code: 8 unambiguous upper-case characters. */
export const PairingCodeSchema = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{8}$/);

export const LanguageSchema = z.enum(['en', 'si', 'ta']).default('en');

/** §5.4.1 - the body of every error response. */
export const ErrorBodySchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  requestId: z.string(),
  details: z.record(z.unknown()).default({}),
});
export type ErrorBody = z.infer<typeof ErrorBodySchema>;

/** §5.4.1 - `?limit=20&cursor=<opaque>`. */
export const PaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});
export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

export const pageOf = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });

export type Page<T> = { items: T[]; nextCursor: string | null };

/** Mutations the app may retry carry this header (§5.4.1); stored for 24 h. */
export const IdempotencyKeySchema = z.string().uuid();

/** Appendix D - English display labels. The UI never invents its own. */
export const INCIDENT_TYPE_LABELS: Record<IncidentType, string> = {
  POSSIBLE_COLLISION: 'Possible collision',
  POSSIBLE_LOW_SPEED_RIDER_DROP: 'Possible low-speed rider drop',
  POSSIBLE_ROLLOVER: 'Possible rollover',
  MANUAL_SOS: 'SOS pressed by rider',
  // TODO(spec): Appendix D prints "Parked bike fell over", but NFR-04 and the
  // pinned decisions require "Possible" on every label except SOS and
  // device-offline. It is still a sensor inference, so NFR-04 wins.
  PARKED_BIKE_FALL: 'Possible parked bike fall',
  POSSIBLE_TOWING: 'Possible towing / unauthorised movement',
  POSSIBLE_TAMPERING: 'Possible device tampering',
  DEVICE_OFFLINE_DURING_RENTAL: 'Device stopped reporting during rental',
  POSSIBLE_POTHOLE: 'Possible pothole / speed bump',
  POSSIBLE_DANGEROUS_CORNERING: 'Possible dangerous cornering',
};

export const incidentTypeLabel = (type: IncidentType): string => INCIDENT_TYPE_LABELS[type];

/** Guard for values arriving from the database as plain strings. */
export const isIncidentType = (value: string): value is IncidentType =>
  (INCIDENT_TYPES as readonly string[]).includes(value);

/**
 * §5.7.3 phone masking: +94•••••4567 - keep the country prefix and last 4.
 * Used in logs, audit metadata, lists and every driver-facing view.
 */
export const maskPhone = (phone: string | null | undefined): string | null => {
  if (!phone) return null;
  const trimmed = phone.trim();
  if (trimmed.length <= 4) return '•'.repeat(trimmed.length);
  const last4 = trimmed.slice(-4);
  const prefix = trimmed.startsWith('+') ? trimmed.slice(0, 3) : '';
  return `${prefix}•••••${last4}`;
};

/** The last four digits a device reports as a consistency check (§5.3.5). */
export const phoneLast4 = (phone: string | null | undefined): string | null =>
  phone ? phone.trim().slice(-4) : null;
