/**
 * §5.7.1 cryptography helpers.
 *
 * Device secrets are stored encrypted (AES-256-GCM with DEVICE_SECRET_KEY)
 * rather than hashed, because HMAC verification needs the raw secret back.
 * Refresh tokens are opaque and stored as SHA-256 - they are never needed in
 * cleartext again.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';

const AES_ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

/** `v1:<iv>:<tag>:<ciphertext>`, all hex - versioned so the scheme can rotate. */
export const encryptSecret = (plaintext: string, keyHex: string): string => {
  const key = Buffer.from(keyHex, 'hex');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(AES_ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('hex')}:${tag.toString('hex')}:${ciphertext.toString('hex')}`;
};

export const decryptSecret = (encrypted: string, keyHex: string): string => {
  const parts = encrypted.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Unrecognised encrypted secret format');
  }
  const [, ivHex, tagHex, dataHex] = parts as [string, string, string, string];
  const decipher = createDecipheriv(AES_ALGORITHM, Buffer.from(keyHex, 'hex'), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
};

/** 32 random bytes as hex - the per-device HMAC secret (§5.7.1). */
export const generateDeviceSecret = (): string => randomBytes(32).toString('hex');

/** Opaque refresh token: 32 random bytes, stored as its SHA-256 (§5.7.1). */
export const generateRefreshToken = (): string => randomBytes(32).toString('hex');

export const sha256Hex = (value: string | Buffer): string =>
  createHash('sha256').update(value).digest('hex');

/**
 * Pairing codes are read aloud and typed in by hand, so the alphabet excludes
 * the characters people confuse: I/1, O/0, S/5, Z/2.
 */
const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRTUVWXY346789';

export const generatePairingCode = (length = 8): string => {
  let code = '';
  for (let i = 0; i < length; i += 1) {
    code += PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)];
  }
  return code;
};

/** WPA2 password for the per-device camera AP (§5.3.11). */
export const generateApPassword = (): string => randomBytes(9).toString('base64url');

/** Constant-time comparison; a length mismatch is itself a mismatch. */
export const safeEqualHex = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
};
