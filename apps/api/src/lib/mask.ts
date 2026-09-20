/**
 * §5.7.3 masking. Phone numbers are masked in logs, audit metadata, lists and
 * every driver-facing view; full numbers appear only in an owner's incident and
 * rental detail.
 */
import { maskPhone } from '@crashlink/contracts';

export { maskPhone };

const PHONE_IN_TEXT = /\+\d{8,15}/g;

/** Scrubs anything that looks like an E.164 number out of a free-text log line. */
export const maskPhonesInText = (text: string): string =>
  text.replace(PHONE_IN_TEXT, (match) => maskPhone(match) ?? match);

const SENSITIVE_KEYS = new Set([
  'phone',
  'phoneE164',
  'ownerPhone',
  'driverPhone',
  'contactPhone',
  'ownerPhoneSnapshot',
  'driverPhoneSnapshot',
  'contactPhoneSnapshot',
  'identifier',
]);

const SECRET_KEYS = new Set([
  'password',
  'newPassword',
  'currentPassword',
  'passwordHash',
  'secret',
  'secretEnc',
  'cameraSecret',
  'apPassword',
  'accessToken',
  'refreshToken',
  'token',
  'tokenHash',
  'pairingCode',
  'pairingCodeHash',
  'sig',
]);

/**
 * Redacts a structure before it reaches pino. Secrets are dropped entirely;
 * phones keep their last four digits so support can still correlate.
 */
export const maskObject = (value: unknown, depth = 0): unknown => {
  if (depth > 6 || value === null || value === undefined) return value;
  if (typeof value === 'string') return maskPhonesInText(value);
  if (Array.isArray(value)) return value.map((item) => maskObject(item, depth + 1));
  if (typeof value !== 'object') return value;

  // Only plain objects are rebuilt. Cloning a class instance (a Fastify
  // Request, an Error) would drop its prototype getters, and pino's own
  // serializers - which already strip the device query string - would then see
  // an object with no `url`.
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEYS.has(key)) {
      result[key] = '[redacted]';
    } else if (SENSITIVE_KEYS.has(key) && typeof item === 'string') {
      result[key] = maskPhone(item);
    } else {
      result[key] = maskObject(item, depth + 1);
    }
  }
  return result;
};
