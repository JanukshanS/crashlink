/**
 * §5.6.5 severity index and integrity hash (FR-INC-11).
 *
 * Unit tests pin the formula and the canonical JSON; integration tests prove
 * the hash is stamped on every creation path, recomputed when the photo
 * completes, and that a later change to the stored evidence is detected.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { scoreForIncident, severityLabel, severityOf, severityScore } from '../src/lib/severity.js';
import { canonicalJson, computeIntegrityHash } from '../src/lib/integrity.js';
import {
  assignRental,
  auth,
  createReadyDriver,
  createTestContext,
  destroyTestContext,
  pairDeviceToBike,
  registerUser,
  resetDatabase,
  type TestContext,
} from './helpers.js';
import { createDevice, heartbeatBody, incidentBody, signedRequest } from './deviceHelpers.js';

// ---------------------------------------------------------------------------
// Unit: the §5.6.5 formula
// ---------------------------------------------------------------------------

describe('severityScore (§5.6.5)', () => {
  it('matches a worked example', () => {
    // 35*(3.1/4) + 25*(220/300) + 25*(24/40) + 15  =  27.125 + 18.333 + 15 + 15
    expect(
      severityScore({
        peakAccelerationG: 3.1,
        peakRotationDps: 220,
        preEventSpeedKph: 24,
        fallenDurationMs: 10_000,
      }),
    ).toBe(75);
  });

  it('caps every term, so the score never exceeds 100', () => {
    expect(
      severityScore({
        peakAccelerationG: 16,
        peakRotationDps: 2000,
        preEventSpeedKph: 120,
        fallenDurationMs: 60_000,
      }),
    ).toBe(100);
  });

  it('treats an unknown speed as 0, as the spec says', () => {
    const withSpeed = severityScore({ peakAccelerationG: 2, peakRotationDps: 150, preEventSpeedKph: 40, fallenDurationMs: 10_000 });
    const unknown = severityScore({ peakAccelerationG: 2, peakRotationDps: 150, preEventSpeedKph: null, fallenDurationMs: 10_000 });
    expect(withSpeed - unknown).toBe(25);
  });

  it('only awards the fallen term at 10 s or more', () => {
    const base = { peakAccelerationG: 0, peakRotationDps: 0, preEventSpeedKph: 0 };
    expect(severityScore({ ...base, fallenDurationMs: 9_999 })).toBe(0);
    expect(severityScore({ ...base, fallenDurationMs: 10_000 })).toBe(15);
  });

  it('labels at the documented boundaries', () => {
    expect(severityLabel(34, 'POSSIBLE_COLLISION')).toBe('LOW');
    expect(severityLabel(35, 'POSSIBLE_COLLISION')).toBe('MODERATE');
    expect(severityLabel(65, 'POSSIBLE_COLLISION')).toBe('MODERATE');
    expect(severityLabel(66, 'POSSIBLE_COLLISION')).toBe('HIGH');
  });

  it('gives MANUAL_SOS the SOS label and a null score, whatever the sensors said', () => {
    expect(severityOf(90, 'MANUAL_SOS')).toEqual({ score: null, label: 'SOS' });
    expect(scoreForIncident('MANUAL_SOS', 'EMERGENCY', { peakAccelerationG: 4 })).toBeNull();
  });

  it('does not score SECURITY or INFO incidents - the formula measures crashes', () => {
    const jolt = { peakAccelerationG: 1.9, peakRotationDps: 40, preEventSpeedKph: 30, fallenDurationMs: 0 };
    expect(scoreForIncident('POSSIBLE_POTHOLE', 'INFO', jolt)).toBeNull();
    expect(scoreForIncident('POSSIBLE_TOWING', 'SECURITY', jolt)).toBeNull();
    expect(scoreForIncident('POSSIBLE_COLLISION', 'EMERGENCY', jolt)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Unit: canonical JSON
// ---------------------------------------------------------------------------

describe('canonicalJson (§5.6.5 "sorted keys")', () => {
  it('is independent of key order at every depth', () => {
    const a = { b: 1, a: { d: [3, 2, 1], c: 'x' } };
    const b = { a: { c: 'x', d: [3, 2, 1] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"c":"x","d":[3,2,1]},"b":1}');
  });

  it('keeps array order, because a sensor trace is ordered data', () => {
    expect(canonicalJson([1, 2, 3])).not.toBe(canonicalJson([3, 2, 1]));
  });

  it('drops undefined and serialises dates as ISO', () => {
    expect(canonicalJson({ a: undefined, t: new Date('2026-09-21T06:30:00.000Z') })).toBe(
      '{"t":"2026-09-21T06:30:00.000Z"}',
    );
  });

  it('changes the hash when any evidence value changes', () => {
    const base = {
      id: 'x',
      bikeId: 'y',
      type: 'POSSIBLE_COLLISION',
      occurredAt: '2026-09-21T06:30:00.000Z',
      lat: 6.9,
      lon: 79.9,
      fixAt: null,
      evidence: { peakAccelerationG: 3.1 },
      sensorWindow: null,
      photoSha256: null,
    };
    const tampered = { ...base, evidence: { peakAccelerationG: 3.2 } };
    const withPhoto = { ...base, photoSha256: 'a'.repeat(64) };

    expect(computeIntegrityHash(base)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(computeIntegrityHash(tampered)).not.toBe(computeIntegrityHash(base));
    expect(computeIntegrityHash(withPhoto)).not.toBe(computeIntegrityHash(base));
  });
});

// ---------------------------------------------------------------------------
// Integration: stamped on creation, refreshed on photo, tamper-evident
// ---------------------------------------------------------------------------

let ctx: TestContext;
let imageDir: string;

beforeAll(async () => {
  imageDir = await mkdtemp(join(tmpdir(), 'crashlink-integrity-'));
  ctx = await createTestContext({ imageDir });
});

afterAll(async () => {
  await destroyTestContext(ctx);
  await rm(imageDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  ctx.clock.set('2026-09-21T06:30:00.000Z');
});

const activeScene = async () => {
  const owner = await registerUser(ctx, 'OWNER');
  const driver = await createReadyDriver(ctx);
  const device = await createDevice(ctx);
  const bikeId = await pairDeviceToBike(ctx, owner, device);

  const { body } = await assignRental(ctx, owner, bikeId, driver.id);
  await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/rentals/${body.id as string}/force-activate`,
    headers: auth(owner.accessToken),
    payload: { confirm: true },
  });

  return {
    owner,
    driver,
    device,
    bikeId,
    rentalId: body.id as string,
    assignmentVersion: body.assignmentVersion as number,
  };
};

/** Recomputes from the stored row exactly as the detail endpoint does. */
const recompute = async (incidentId: string, photoSha256: string | null) => {
  const row = await ctx.prisma.incident.findUniqueOrThrow({ where: { id: incidentId } });
  return computeIntegrityHash({ ...row, photoSha256 });
};

describe('severity and integrity on incident creation', () => {
  it('scores a device collision and stamps a hash that recomputes from the stored row', async () => {
    const scene = await activeScene();
    const eventId = randomUUID();

    const response = await ctx.app.inject(
      signedRequest(ctx, scene.device, {
        method: 'PUT',
        path: `/d/v1/incidents/${eventId}`,
        body: incidentBody(ctx, {
          eventId,
          rentalId: scene.rentalId,
          assignmentVersion: scene.assignmentVersion,
        }),
      }),
    );
    expect(response.statusCode).toBe(200);

    const incident = await ctx.prisma.incident.findUniqueOrThrow({ where: { id: eventId } });
    expect(incident.severityScore).toBe(75);
    expect(incident.integrityHash).toMatch(/^sha256:[0-9a-f]{64}$/);

    // Survives the JSONB round trip: key reordering must not break it.
    expect(incident.integrityHash).toBe(await recompute(eventId, null));

    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/incidents/${eventId}`,
      headers: auth(scene.owner.accessToken),
    });
    expect(detail.json().severity).toMatchObject({ score: 75, label: 'HIGH' });
    expect(detail.json().severity.note).toMatch(/not a medical assessment/);
  });

  it('gives a SECURITY incident no score, but still a hash', async () => {
    const scene = await activeScene();
    const eventId = randomUUID();

    await ctx.app.inject(
      signedRequest(ctx, scene.device, {
        method: 'PUT',
        path: `/d/v1/incidents/${eventId}`,
        body: incidentBody(ctx, { eventId, type: 'POSSIBLE_TOWING', ignition: 'OFF' }),
      }),
    );

    const incident = await ctx.prisma.incident.findUniqueOrThrow({ where: { id: eventId } });
    expect(incident.severityScore).toBeNull();
    expect(incident.integrityHash).toBe(await recompute(eventId, null));
  });

  it('stamps a hash on server-raised incidents too: app SOS and dead-man', async () => {
    const scene = await activeScene();

    const sos = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/drivers/me/sos',
      headers: auth(scene.driver.accessToken),
      payload: { idempotencyKey: randomUUID(), lat: 6.91, lon: 79.97 },
    });
    expect(sos.statusCode).toBe(201);

    const sosRow = await ctx.prisma.incident.findUniqueOrThrow({ where: { id: sos.json().incidentId } });
    expect(sosRow.severityScore).toBeNull();
    expect(sosRow.integrityHash).toBe(await recompute(sosRow.id, null));

    // Dead-man: one heartbeat, then silence past the 90 s threshold.
    await ctx.app.inject(
      signedRequest(ctx, scene.device, { method: 'POST', path: '/d/v1/heartbeat', body: heartbeatBody(ctx) }),
    );
    ctx.clock.advanceSeconds(ctx.config.DEADMAN_ON_SEC + 30);
    await ctx.app.workers.runOnce('deadMan');

    const deadMan = await ctx.prisma.incident.findFirstOrThrow({
      where: { type: 'DEVICE_OFFLINE_DURING_RENTAL' },
    });
    expect(deadMan.integrityHash).toBe(await recompute(deadMan.id, null));
  });
});

describe('integrity after image completion (§5.6.5 "recomputed when the photo completes")', () => {
  const upload = async (
    device: Awaited<ReturnType<typeof createDevice>>,
    eventId: string,
    image: Buffer,
    declaredSha: string,
  ) => {
    const session = await ctx.app.inject(
      signedRequest(ctx, device, {
        method: 'POST',
        path: `/d/v1/incidents/${eventId}/image/session`,
        body: { schema: 1, bytes: image.length, sha256: declaredSha, chunkSize: 2048, mime: 'image/jpeg' },
      }),
    );
    const sessionId = session.json().sessionId as string;

    for (let offset = 0; offset < image.length; offset += 2048) {
      await ctx.app.inject(
        signedRequest(ctx, device, {
          method: 'PUT',
          path: `/d/v1/images/${sessionId}/chunks/${offset}`,
          rawBody: image.subarray(offset, offset + 2048),
        }),
      );
    }

    return ctx.app.inject(
      signedRequest(ctx, device, { method: 'POST', path: `/d/v1/images/${sessionId}/complete`, body: {} }),
    );
  };

  it('folds the verified photo hash in, and the detail view reports VERIFIED', async () => {
    const scene = await activeScene();
    const eventId = randomUUID();

    await ctx.app.inject(
      signedRequest(ctx, scene.device, {
        method: 'PUT',
        path: `/d/v1/incidents/${eventId}`,
        body: incidentBody(ctx, { eventId, rentalId: scene.rentalId, assignmentVersion: scene.assignmentVersion }),
      }),
    );
    const before = (await ctx.prisma.incident.findUniqueOrThrow({ where: { id: eventId } })).integrityHash;

    const image = Buffer.concat([Buffer.from([0xff, 0xd8]), randomBytes(3000), Buffer.from([0xff, 0xd9])]);
    const sha = createHash('sha256').update(image).digest('hex');
    const complete = await upload(scene.device, eventId, image, sha);
    expect(complete.json().state).toBe('COMPLETE');

    const after = (await ctx.prisma.incident.findUniqueOrThrow({ where: { id: eventId } })).integrityHash;
    expect(after).not.toBe(before);
    expect(after).toBe(await recompute(eventId, sha));

    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/incidents/${eventId}`,
      headers: auth(scene.owner.accessToken),
    });
    expect(detail.json().photo).toMatchObject({ status: 'AVAILABLE', integrity: 'VERIFIED', sha256: sha });
  });

  it('leaves a failed photo out of the hash', async () => {
    const scene = await activeScene();
    const eventId = randomUUID();

    await ctx.app.inject(
      signedRequest(ctx, scene.device, {
        method: 'PUT',
        path: `/d/v1/incidents/${eventId}`,
        body: incidentBody(ctx, { eventId, rentalId: scene.rentalId, assignmentVersion: scene.assignmentVersion }),
      }),
    );

    const image = Buffer.concat([Buffer.from([0xff, 0xd8]), randomBytes(2000), Buffer.from([0xff, 0xd9])]);
    const complete = await upload(scene.device, eventId, image, 'b'.repeat(64));
    expect(complete.json().state).toBe('FAILED');

    const row = await ctx.prisma.incident.findUniqueOrThrow({ where: { id: eventId } });
    expect(row.integrityHash).toBe(await recompute(eventId, null));
  });

  it('detects evidence changed after the fact as MISMATCH', async () => {
    const scene = await activeScene();
    const eventId = randomUUID();

    await ctx.app.inject(
      signedRequest(ctx, scene.device, {
        method: 'PUT',
        path: `/d/v1/incidents/${eventId}`,
        body: incidentBody(ctx, { eventId, rentalId: scene.rentalId, assignmentVersion: scene.assignmentVersion }),
      }),
    );

    const image = Buffer.concat([Buffer.from([0xff, 0xd8]), randomBytes(2500), Buffer.from([0xff, 0xd9])]);
    const sha = createHash('sha256').update(image).digest('hex');
    await upload(scene.device, eventId, image, sha);

    // Someone edits the stored evidence directly - the hash must notice.
    await ctx.prisma.incident.update({
      where: { id: eventId },
      data: { evidence: { fallenDurationMs: 10_000, peakAccelerationG: 1.2, simulated: false } },
    });

    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/incidents/${eventId}`,
      headers: auth(scene.owner.accessToken),
    });
    expect(detail.json().photo.integrity).toBe('MISMATCH');
  });
});
