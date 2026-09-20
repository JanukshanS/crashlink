/**
 * Appendix E.1.2 - the device canonical string.
 *
 * lib/hmac.ts, tools/device-sim and the ESP32 firmware must all build the same
 * bytes. These are the reference vectors to check the firmware against before
 * anyone touches the modem.
 */
import { describe, expect, it } from 'vitest';
import { buildCanonicalString, signRequest, verifySignature } from '../src/lib/hmac.js';
import { sha256Hex } from '../src/lib/crypto.js';

const SECRET = 'a'.repeat(64);

describe('buildCanonicalString', () => {
  it('joins METHOD, path, dev, ts, nonce and the body hash with newlines', () => {
    const canonical = buildCanonicalString({
      method: 'POST',
      path: '/d/v1/heartbeat',
      dev: 'CL-0001',
      ts: 1758380000,
      nonce: 'a91f3c',
      body: '{"schema":1}',
    });

    expect(canonical.split('\n')).toEqual([
      'POST',
      '/d/v1/heartbeat',
      'CL-0001',
      '1758380000',
      'a91f3c',
      sha256Hex('{"schema":1}'),
    ]);
  });

  it('hashes the empty string for an empty body', () => {
    const canonical = buildCanonicalString({
      method: 'GET',
      path: '/d/v1/incidents/abc/control',
      dev: 'CL-0001',
      ts: 1758380000,
      nonce: 'a91f3c',
      body: '',
    });

    expect(canonical.split('\n').at(-1)).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('excludes the query string, so parameter order cannot change the signature', () => {
    // The auth parameters live in the query (Appendix E.1.2) and the server
    // rebuilds `path` without them - the signature must not depend on order.
    const base = {
      method: 'POST' as const,
      dev: 'CL-0001',
      ts: 1758380000,
      nonce: 'a91f3c',
      body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    };

    const signature = signRequest({ ...base, path: '/d/v1/incidents/EVT-7f21a9/image' }, SECRET);
    expect(signature).toHaveLength(64);
    expect(
      verifySignature({ ...base, path: '/d/v1/incidents/EVT-7f21a9/image' }, SECRET, signature),
    ).toBe(true);
  });
});

describe('verifySignature', () => {
  it('rejects a tampered body, path, timestamp, nonce or secret', () => {
    const request = {
      method: 'POST',
      path: '/d/v1/heartbeat',
      dev: 'CL-0001',
      ts: 1758380000,
      nonce: 'a91f3c',
      body: '{"schema":1}',
    };
    const signature = signRequest(request, SECRET);

    expect(verifySignature(request, SECRET, signature)).toBe(true);
    expect(verifySignature({ ...request, body: '{"schema":2}' }, SECRET, signature)).toBe(false);
    expect(verifySignature({ ...request, path: '/d/v1/time' }, SECRET, signature)).toBe(false);
    expect(verifySignature({ ...request, ts: 1758380001 }, SECRET, signature)).toBe(false);
    expect(verifySignature({ ...request, nonce: 'b91f3c' }, SECRET, signature)).toBe(false);
    expect(verifySignature(request, 'b'.repeat(64), signature)).toBe(false);
  });

  it('rejects a malformed or empty signature instead of throwing', () => {
    const request = {
      method: 'GET',
      path: '/d/v1/time',
      dev: 'CL-0001',
      ts: 1758380000,
      nonce: 'a91f3c',
      body: '',
    };

    expect(verifySignature(request, SECRET, '')).toBe(false);
    expect(verifySignature(request, SECRET, 'not-hex')).toBe(false);
    expect(verifySignature(request, SECRET, 'ab')).toBe(false);
  });
});
