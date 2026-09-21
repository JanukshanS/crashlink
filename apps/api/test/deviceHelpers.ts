/**
 * A signing client for `/d/v1`, used by the device tests.
 *
 * It signs exactly as Appendix E.1.2 specifies and as tools/device-sim and the
 * firmware must: if this helper and the server ever disagree, the tests fail
 * rather than the demo.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { InjectOptions } from 'fastify';
import { DEFAULT_DEVICE_CONFIG } from '@crashlink/contracts';
import { encryptSecret, generatePairingCode } from '../src/lib/crypto.js';
import { signRequest } from '../src/lib/hmac.js';
import type { TestContext } from './helpers.js';

export interface TestDevice {
  id: string;
  code: string;
  secret: string;
  pairingCode: string;
}

let deviceCounter = 0;

/** Provisions a device directly, the way the CLI would. */
export const createDevice = async (
  ctx: TestContext,
  overrides: { demoMode?: boolean } = {},
): Promise<TestDevice> => {
  deviceCounter += 1;
  const code = `CL-${String(7000 + deviceCounter).padStart(4, '0')}`;
  const secret = randomBytes(32).toString('hex');
  const pairingCode = generatePairingCode();

  const device = await ctx.prisma.device.create({
    data: {
      code,
      secretEnc: encryptSecret(secret, ctx.config.DEVICE_SECRET_KEY),
      pairingCodeHash: await bcrypt.hash(pairingCode, 10),
      config: {
        ...DEFAULT_DEVICE_CONFIG,
        demoMode: overrides.demoMode ?? false,
      } as unknown as object,
    },
  });

  return { id: device.id, code, secret, pairingCode };
};

export interface SignOverrides {
  /** Forces a specific unix timestamp - used to test STALE_TIMESTAMP. */
  ts?: number;
  /** Forces a specific nonce - used to test REPLAYED_NONCE. */
  nonce?: string;
  /** Replaces the computed signature - used to test BAD_SIGNATURE. */
  sig?: string;
}

/**
 * Builds a signed `app.inject()` request. The body is serialised once and both
 * signed and sent as those exact bytes - signing a different serialisation than
 * the one transmitted is the classic way this goes wrong.
 */
export const signedRequest = (
  ctx: TestContext,
  device: TestDevice,
  input: {
    method: 'GET' | 'POST' | 'PUT';
    path: string;
    body?: unknown;
    rawBody?: Buffer;
    contentType?: string;
  },
  overrides: SignOverrides = {},
): InjectOptions => {
  const payload =
    input.rawBody ??
    (input.body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(input.body), 'utf8'));

  const ts = overrides.ts ?? Math.floor(ctx.clock.now().getTime() / 1000);
  const nonce = overrides.nonce ?? randomBytes(8).toString('hex');

  const sig =
    overrides.sig ??
    signRequest(
      { method: input.method, path: input.path, dev: device.code, ts, nonce, body: payload },
      device.secret,
    );

  const query = `?dev=${device.code}&ts=${ts}&nonce=${nonce}&sig=${sig}`;

  return {
    method: input.method,
    url: `${input.path}${query}`,
    payload,
    headers: {
      'content-type':
        input.contentType ?? (input.rawBody ? 'application/octet-stream' : 'application/json'),
    },
  };
};

/** The §5.3.3 heartbeat body, with sensible defaults per field. */
export const heartbeatBody = (
  ctx: TestContext,
  overrides: Partial<{
    ignition: 'ON' | 'OFF' | 'UNKNOWN';
    assignmentVersion: number | null;
    configVersion: number;
    fixes: unknown[];
    events: unknown[];
    mode: string;
    activeEventId: string | null;
  }> = {},
): Record<string, unknown> => ({
  schema: 1,
  deviceTime: ctx.clock.now().toISOString(),
  timeSource: 'GPS',
  fw: '1.0.0',
  assignmentVersion: overrides.assignmentVersion ?? null,
  configVersion: overrides.configVersion ?? 1,
  ignition: {
    state: overrides.ignition ?? 'ON',
    changedAt: ctx.clock.now().toISOString(),
  },
  ignitionEvents: [],
  fixes: overrides.fixes ?? [],
  events: overrides.events ?? [],
  health: {
    csq: 17,
    gprs: true,
    gpsFix: true,
    sats: 7,
    hdop: 1.1,
    cameraLink: true,
    // M10: never measured.
    batteryV: null,
    freeHeap: 81234,
    uptimeS: 3600,
    queuedJobs: 0,
    demoMode: false,
    resetReason: 'POWERON',
  },
  state: { mode: overrides.mode ?? 'MONITORING', activeEventId: overrides.activeEventId ?? null },
});

/** The §5.3.5 incident body for a confirmed fall. */
export const incidentBody = (
  ctx: TestContext,
  overrides: Partial<{
    eventId: string;
    rentalId: string | null;
    assignmentVersion: number | null;
    type: string;
    ignition: 'ON' | 'OFF' | 'UNKNOWN';
    preEventSpeedKph: number | null;
    localDecision: unknown;
    photoStatus: string;
    occurredAt: string;
  }> = {},
): Record<string, unknown> => ({
  schema: 1,
  eventId: overrides.eventId ?? randomUUID(),
  rentalId: overrides.rentalId ?? null,
  assignmentVersion: overrides.assignmentVersion ?? null,
  type: overrides.type ?? 'POSSIBLE_COLLISION',
  occurredAt: overrides.occurredAt ?? ctx.clock.now().toISOString(),
  timeSource: 'GPS',
  ignition: overrides.ignition ?? 'ON',
  preEventSpeedKph: overrides.preEventSpeedKph ?? 24,
  evidence: {
    fallenDurationMs: 10_000,
    peakAccelerationG: 3.1,
    peakRotationDps: 220,
    maxTiltDeg: 88,
    simulated: false,
  },
  sensorWindow: {
    hz: 5,
    t0: ctx.clock.now().toISOString(),
    a: [1.0, 1.1, 3.1, 0.9],
    g: [5, 40, 220, 12],
    tilt: [3, 20, 88, 88],
    spd: [24, 20, 4, 0],
  },
  location: {
    kind: 'LIVE',
    lat: 6.9147,
    lon: 79.9729,
    fixAt: ctx.clock.now().toISOString(),
    ageSecondsAtEvent: 2,
    src: 'GPS',
  },
  photoStatus: overrides.photoStatus ?? 'PENDING',
  localDecision: overrides.localDecision ?? null,
});
