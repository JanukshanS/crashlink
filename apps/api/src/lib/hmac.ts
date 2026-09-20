/**
 * Device request signing - Appendix E.1.2, which overrides §5.3.2.
 *
 * Auth travels in the query string (`?dev=&ts=&nonce=&sig=`) because custom
 * headers on the SIM800L need `AT+HTTPPARA="USERDATA"`, which only some modem
 * firmware revisions have. The canonical string is:
 *
 *   METHOD \n path \n dev \n ts \n nonce \n sha256hex(body)
 *
 * `path` excludes the query string entirely, so the server rebuilds it without
 * any parsing-order ambiguity. lib/hmac.ts, tools/device-sim and the firmware
 * must all produce byte-identical strings.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { sha256Hex } from './crypto.js';

export interface CanonicalRequest {
  method: string;
  /** Path only - no query string, no trailing slash normalisation. */
  path: string;
  dev: string;
  ts: number | string;
  nonce: string;
  body: Buffer | string;
}

export const buildCanonicalString = (req: CanonicalRequest): string =>
  [
    req.method.toUpperCase(),
    req.path,
    req.dev,
    String(req.ts),
    req.nonce,
    sha256Hex(typeof req.body === 'string' ? Buffer.from(req.body, 'utf8') : req.body),
  ].join('\n');

/**
 * The device secret is 32 bytes carried as 64 hex characters; it is decoded
 * before use so firmware (which holds raw bytes) and server agree.
 */
export const signCanonical = (canonical: string, secretHex: string): string =>
  createHmac('sha256', Buffer.from(secretHex, 'hex')).update(canonical, 'utf8').digest('hex');

export const signRequest = (req: CanonicalRequest, secretHex: string): string =>
  signCanonical(buildCanonicalString(req), secretHex);

export const verifySignature = (req: CanonicalRequest, secretHex: string, signature: string): boolean => {
  const expected = Buffer.from(signRequest(req, secretHex), 'hex');
  let provided: Buffer;
  try {
    provided = Buffer.from(signature, 'hex');
  } catch {
    return false;
  }
  if (expected.length !== provided.length || provided.length === 0) return false;
  return timingSafeEqual(expected, provided);
};
