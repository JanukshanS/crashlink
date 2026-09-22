/**
 * §5.3 device gateway: signing (Appendix E.1.2), heartbeat ingest, commands,
 * notification reporting, and the chunked image upload of §4.4.3.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

let ctx: TestContext;
let imageDir: string;

beforeAll(async () => {
  imageDir = await mkdtemp(join(tmpdir(), 'crashlink-images-'));
  ctx = await createTestContext({ imageDir });
});

afterAll(async () => {
  await destroyTestContext(ctx);
  await rm(imageDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  ctx.clock.set('2026-09-21T06:30:00.000Z');
  ctx.realtime.clear();
});

describe('§5.3.2 request signing (Appendix E.1.2)', () => {
  it('GET /d/v1/time is unsigned and returns the server clock', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/d/v1/time' });

    expect(response.statusCode).toBe(200);
    expect(response.json().serverTime).toBe(ctx.clock.now().toISOString());
    expect(response.json().epoch).toBe(Math.floor(ctx.clock.now().getTime() / 1000));
  });

  it('accepts a correctly signed heartbeat', async () => {
    const device = await createDevice(ctx);

    const response = await ctx.app.inject(
      signedRequest(ctx, device, {
        method: 'POST',
        path: '/d/v1/heartbeat',
        body: heartbeatBody(ctx),
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(response.json().serverTime).toBe(ctx.clock.now().toISOString());
    expect(Array.isArray(response.json().commands)).toBe(true);
  });

  it('rejects a bad signature with BAD_SIGNATURE', async () => {
    const device = await createDevice(ctx);

    const response = await ctx.app.inject(
      signedRequest(
        ctx,
        device,
        { method: 'POST', path: '/d/v1/heartbeat', body: heartbeatBody(ctx) },
        { sig: 'f'.repeat(64) },
      ),
    );

    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe('BAD_SIGNATURE');
  });

  it('rejects a body altered after signing', async () => {
    const device = await createDevice(ctx);

    const signed = signedRequest(ctx, device, {
      method: 'POST',
      path: '/d/v1/heartbeat',
      body: heartbeatBody(ctx),
    });

    // Same signature, different bytes - the content hash must catch it.
    const tampered = {
      ...signed,
      payload: Buffer.from(JSON.stringify(heartbeatBody(ctx, { ignition: 'OFF' })), 'utf8'),
    };

    const response = await ctx.app.inject(tampered);
    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe('BAD_SIGNATURE');
  });

  it('rejects a stale timestamp with STALE_TIMESTAMP', async () => {
    const device = await createDevice(ctx);
    const nowSec = Math.floor(ctx.clock.now().getTime() / 1000);

    for (const ts of [nowSec - 301, nowSec + 301]) {
      const response = await ctx.app.inject(
        signedRequest(ctx, device, { method: 'POST', path: '/d/v1/heartbeat', body: heartbeatBody(ctx) }, { ts }),
      );
      expect(response.statusCode, `ts=${ts}`).toBe(401);
      expect(response.json().code).toBe('STALE_TIMESTAMP');
    }

    // Just inside the ±300 s window is fine.
    const inside = await ctx.app.inject(
      signedRequest(
        ctx,
        device,
        { method: 'POST', path: '/d/v1/heartbeat', body: heartbeatBody(ctx) },
        { ts: nowSec - 299 },
      ),
    );
    expect(inside.statusCode).toBe(200);
  });

  it('rejects a replayed nonce with REPLAYED_NONCE', async () => {
    const device = await createDevice(ctx);
    const nonce = randomBytes(8).toString('hex');

    const request = signedRequest(
      ctx,
      device,
      { method: 'POST', path: '/d/v1/heartbeat', body: heartbeatBody(ctx) },
      { nonce },
    );

    const first = await ctx.app.inject(request);
    expect(first.statusCode).toBe(200);

    // Byte-for-byte the same request: a captured packet replayed.
    const replay = await ctx.app.inject(request);
    expect(replay.statusCode).toBe(401);
    expect(replay.json().code).toBe('REPLAYED_NONCE');
  });

  it('rejects a revoked device with DEVICE_REVOKED (FR-DEV-06)', async () => {
    const device = await createDevice(ctx);
    await ctx.prisma.device.update({
      where: { id: device.id },
      data: { revokedAt: ctx.clock.now() },
    });

    const response = await ctx.app.inject(
      signedRequest(ctx, device, { method: 'POST', path: '/d/v1/heartbeat', body: heartbeatBody(ctx) }),
    );

    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe('DEVICE_REVOKED');
  });

  it('answers an unknown device code exactly like a bad signature', async () => {
    const device = await createDevice(ctx);
    const unknown = { ...device, code: 'CL-9998' };

    const response = await ctx.app.inject(
      signedRequest(ctx, unknown, { method: 'POST', path: '/d/v1/heartbeat', body: heartbeatBody(ctx) }),
    );

    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe('BAD_SIGNATURE');
  });
});

describe('§5.3.3 heartbeat ingest', () => {
  it('stores fixes, updates the bike and rejects implausible coordinates per item', async () => {
    const owner = await registerUser(ctx, 'OWNER');
    const device = await createDevice(ctx);
    const bikeId = await pairDeviceToBike(ctx, owner, device);

    const t0 = ctx.clock.now();
    const response = await ctx.app.inject(
      signedRequest(ctx, device, {
        method: 'POST',
        path: '/d/v1/heartbeat',
        body: heartbeatBody(ctx, {
          fixes: [
            { t: new Date(t0.getTime() - 20_000).toISOString(), lat: 6.9147, lon: 79.9729, spd: 18, hdop: 1.1, sat: 7, valid: true, src: 'GPS' },
            // Null island: the module has no fix yet.
            { t: new Date(t0.getTime() - 15_000).toISOString(), lat: 0, lon: 0, spd: 0, hdop: 9, sat: 0, valid: false, src: 'GPS' },
            // Out of range.
            { t: new Date(t0.getTime() - 10_000).toISOString(), lat: 91, lon: 200, spd: 0, hdop: 1, sat: 5, valid: true, src: 'GPS' },
            { t: new Date(t0.getTime() - 5_000).toISOString(), lat: 6.9152, lon: 79.9735, spd: 21, hdop: 1.0, sat: 8, valid: true, src: 'GPS' },
          ],
        }),
      }),
    );

    expect(response.statusCode).toBe(200);

    // The good fixes landed; the bad ones were dropped individually, not by
    // failing the whole request (§5.3.3).
    expect(await ctx.prisma.locationSample.count({ where: { bikeId } })).toBe(2);

    const bike = await ctx.prisma.bike.findUniqueOrThrow({ where: { id: bikeId } });
    expect(bike.lastLat).toBeCloseTo(6.9152, 4);
    expect(bike.ignition).toBe('ON');

    const stored = await ctx.prisma.device.findUniqueOrThrow({ where: { id: device.id } });
    expect(stored.lastSeenAt?.toISOString()).toBe(t0.toISOString());
    expect(stored.firmwareVersion).toBe('1.0.0');

    // §5.5: the owner's dashboard is pushed the update.
    expect(ctx.realtime.byName('bike.updated').length).toBeGreaterThanOrEqual(1);
    expect(ctx.realtime.byName('device.status').length).toBeGreaterThanOrEqual(1);
  });

  it('de-duplicates a resent batch (§5.6.4)', async () => {
    const owner = await registerUser(ctx, 'OWNER');
    const device = await createDevice(ctx);
    const bikeId = await pairDeviceToBike(ctx, owner, device);

    const fixes = [
      { t: ctx.clock.now().toISOString(), lat: 6.9147, lon: 79.9729, spd: 18, hdop: 1.1, sat: 7, valid: true, src: 'GPS' },
    ];

    for (let i = 0; i < 3; i += 1) {
      const response = await ctx.app.inject(
        signedRequest(ctx, device, { method: 'POST', path: '/d/v1/heartbeat', body: heartbeatBody(ctx, { fixes }) }),
      );
      expect(response.statusCode).toBe(200);
    }

    expect(await ctx.prisma.locationSample.count({ where: { bikeId } })).toBe(1);
  });

  it('rejects DEMO-sourced fixes unless the device config allows them', async () => {
    const owner = await registerUser(ctx, 'OWNER');
    const strict = await createDevice(ctx, { demoMode: false });
    const bikeId = await pairDeviceToBike(ctx, owner, strict);

    const fixes = [
      { t: ctx.clock.now().toISOString(), lat: 6.9147, lon: 79.9729, spd: 18, hdop: 1.1, sat: 7, valid: true, src: 'DEMO' },
    ];

    await ctx.app.inject(
      signedRequest(ctx, strict, { method: 'POST', path: '/d/v1/heartbeat', body: heartbeatBody(ctx, { fixes }) }),
    );
    expect(await ctx.prisma.locationSample.count({ where: { bikeId } })).toBe(0);

    // A device explicitly in demo mode may emit them.
    const demo = await createDevice(ctx, { demoMode: true });
    const demoBike = await pairDeviceToBike(ctx, owner, demo, 'Simulator bike');
    await ctx.app.inject(
      signedRequest(ctx, demo, { method: 'POST', path: '/d/v1/heartbeat', body: heartbeatBody(ctx, { fixes }) }),
    );
    expect(await ctx.prisma.locationSample.count({ where: { bikeId: demoBike } })).toBe(1);
  });

  it('accumulates trip distance on an ACTIVE rental (FR-RENT-05)', async () => {
    const owner = await registerUser(ctx, 'OWNER');
    const driver = await createReadyDriver(ctx);
    const device = await createDevice(ctx);
    const bikeId = await pairDeviceToBike(ctx, owner, device);

    const { body } = await assignRental(ctx, owner, bikeId, driver.id);
    const rentalId = body.id as string;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/rentals/${rentalId}/force-activate`,
      headers: auth(owner.accessToken),
      payload: { confirm: true },
    });

    const t0 = ctx.clock.now();
    // ~111 m apart, 30 s apart: well inside the plausibility limits.
    const fixes = [
      { t: new Date(t0.getTime() - 60_000).toISOString(), lat: 6.9140, lon: 79.9729, spd: 15, hdop: 1.0, sat: 8, valid: true, src: 'GPS' },
      { t: new Date(t0.getTime() - 30_000).toISOString(), lat: 6.9150, lon: 79.9729, spd: 15, hdop: 1.0, sat: 8, valid: true, src: 'GPS' },
    ];

    await ctx.app.inject(
      signedRequest(ctx, device, { method: 'POST', path: '/d/v1/heartbeat', body: heartbeatBody(ctx, { fixes }) }),
    );

    const rental = await ctx.prisma.rental.findUniqueOrThrow({ where: { id: rentalId } });
    expect(rental.distanceMeters).toBeGreaterThan(90);
    expect(rental.distanceMeters).toBeLessThan(130);
  });
});

describe('§5.3.4 commands', () => {
  it('delivers SET_ASSIGNMENT and activates the rental on ack (FR-RENT-03)', async () => {
    const owner = await registerUser(ctx, 'OWNER');
    const driver = await createReadyDriver(ctx);
    const device = await createDevice(ctx);
    const bikeId = await pairDeviceToBike(ctx, owner, device);

    const { body } = await assignRental(ctx, owner, bikeId, driver.id);
    const rentalId = body.id as string;

    const heartbeat = await ctx.app.inject(
      signedRequest(ctx, device, { method: 'POST', path: '/d/v1/heartbeat', body: heartbeatBody(ctx) }),
    );

    const commands = heartbeat.json().commands as { id: string; type: string; payload: Record<string, unknown> }[];
    expect(commands).toHaveLength(1);
    expect(commands[0]?.type).toBe('SET_ASSIGNMENT');
    // The bike is given exactly the numbers it will text.
    expect(commands[0]?.payload).toMatchObject({ rentalId, contactName: 'Diroshan' });

    // Still PENDING_SYNC until the device says it persisted the snapshot.
    expect((await ctx.prisma.rental.findUniqueOrThrow({ where: { id: rentalId } })).state).toBe('PENDING_SYNC');

    const ack = await ctx.app.inject(
      signedRequest(ctx, device, {
        method: 'POST',
        path: `/d/v1/commands/${commands[0]!.id}/ack`,
        body: { result: 'APPLIED', assignmentVersion: 1 },
      }),
    );
    expect(ack.statusCode).toBe(200);

    const rental = await ctx.prisma.rental.findUniqueOrThrow({ where: { id: rentalId } });
    expect(rental.state).toBe('ACTIVE');
    expect(rental.deviceAckAt).not.toBeNull();
    // Not a demo override: the bike really confirmed.
    expect(rental.demoOverride).toBe(false);
  });

  it('acks are idempotent and stop redelivery', async () => {
    const owner = await registerUser(ctx, 'OWNER');
    const driver = await createReadyDriver(ctx);
    const device = await createDevice(ctx);
    const bikeId = await pairDeviceToBike(ctx, owner, device);
    await assignRental(ctx, owner, bikeId, driver.id);

    const first = await ctx.app.inject(
      signedRequest(ctx, device, { method: 'POST', path: '/d/v1/heartbeat', body: heartbeatBody(ctx) }),
    );
    const commandId = (first.json().commands as { id: string }[])[0]!.id;

    for (let i = 0; i < 3; i += 1) {
      const ack = await ctx.app.inject(
        signedRequest(ctx, device, {
          method: 'POST',
          path: `/d/v1/commands/${commandId}/ack`,
          body: { result: 'APPLIED', assignmentVersion: 1 },
        }),
      );
      expect(ack.statusCode).toBe(200);
    }

    // Acked commands are no longer piggybacked.
    const after = await ctx.app.inject(
      signedRequest(ctx, device, { method: 'POST', path: '/d/v1/heartbeat', body: heartbeatBody(ctx) }),
    );
    expect(after.json().commands).toHaveLength(0);
  });

  it('expires commands past their TTL (§5.3.4)', async () => {
    const owner = await registerUser(ctx, 'OWNER');
    const driver = await createReadyDriver(ctx);
    const device = await createDevice(ctx);
    const bikeId = await pairDeviceToBike(ctx, owner, device);
    await assignRental(ctx, owner, bikeId, driver.id);

    // 24 h + 1 min later the assignment is stale and must not be applied.
    ctx.clock.advanceSeconds(24 * 60 * 60 + 60);
    await ctx.app.workers.runOnce('commandExpiry');

    const command = await ctx.prisma.deviceCommand.findFirstOrThrow({ where: { type: 'SET_ASSIGNMENT' } });
    expect(command.status).toBe('EXPIRED');

    const heartbeat = await ctx.app.inject(
      signedRequest(ctx, device, { method: 'POST', path: '/d/v1/heartbeat', body: heartbeatBody(ctx) }),
    );
    expect(heartbeat.json().commands).toHaveLength(0);
  });
});

describe('§5.3.7 notification reporting', () => {
  it('records attempts append-only and never downgrades the logical state', async () => {
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

    const eventId = randomUUID();
    await ctx.app.inject(
      signedRequest(ctx, device, {
        method: 'PUT',
        path: `/d/v1/incidents/${eventId}`,
        body: incidentBody(ctx, {
          eventId,
          rentalId: body.id as string,
          assignmentVersion: body.assignmentVersion as number,
        }),
      }),
    );

    const report = async (state: string, attemptNo = 1, detail?: string) =>
      ctx.app.inject(
        signedRequest(ctx, device, {
          method: 'POST',
          path: `/d/v1/incidents/${eventId}/notifications`,
          body: {
            schema: 1,
            kind: 'OWNER_SMS',
            attemptNo,
            state,
            detail: detail ?? null,
            deviceTime: ctx.clock.now().toISOString(),
          },
        }),
      );

    expect((await report('QUEUED')).statusCode).toBe(200);
    expect((await report('AT_SUBMITTED', 1, '+CMGS: 23')).statusCode).toBe(200);

    // The same report arriving twice must not inflate the history.
    expect((await report('AT_SUBMITTED', 1, '+CMGS: 23')).statusCode).toBe(200);

    const notification = await ctx.prisma.notification.findFirstOrThrow({
      where: { incidentId: eventId, kind: 'OWNER_SMS' },
      include: { attempts: true },
    });

    expect(notification.attempts).toHaveLength(2);
    expect(notification.state).toBe('AT_SUBMITTED');

    // A late QUEUED report must not walk the state backwards (FR-NOT-02).
    await report('QUEUED');
    const after = await ctx.prisma.notification.findFirstOrThrow({
      where: { incidentId: eventId, kind: 'OWNER_SMS' },
    });
    expect(after.state).toBe('AT_SUBMITTED');
  });

  it('records the rider SMS against the rider snapshot, masked, and says so on the timeline', async () => {
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
    const eventId = randomUUID();
    await ctx.app.inject(
      signedRequest(ctx, device, {
        method: 'POST',
        path: `/d/v1/incidents/${eventId}`,
        body: incidentBody(ctx, { eventId, rentalId: body.id as string, assignmentVersion: body.assignmentVersion as number }),
      }),
    );

    const sent = await ctx.app.inject(
      signedRequest(ctx, device, {
        method: 'POST',
        path: `/d/v1/incidents/${eventId}/notifications`,
        body: { schema: 1, kind: 'DRIVER_SMS', attemptNo: 1, state: 'AT_SUBMITTED', detail: '+CMGS: 7', deviceTime: ctx.clock.now().toISOString() },
      }),
    );
    expect(sent.statusCode).toBe(200);

    const rental = await ctx.prisma.rental.findUniqueOrThrow({ where: { id: body.id as string } });
    const notification = await ctx.prisma.notification.findFirstOrThrow({ where: { incidentId: eventId, kind: 'DRIVER_SMS' } });
    expect(notification.state).toBe('AT_SUBMITTED');
    // Masked (§5.7.3), and it is the rider's number from the rental snapshot.
    expect(notification.recipientMasked).toContain('•');
    expect(notification.recipientMasked?.slice(-4)).toBe(rental.driverPhoneSnapshot?.slice(-4));

    const detail = await ctx.app.inject({ method: 'GET', url: `/api/v1/incidents/${eventId}`, headers: auth(owner.accessToken) });
    const timeline = (detail.json().timeline as { text: string }[]).map((entry) => entry.text).join(' | ');
    expect(timeline).toContain('Rider SMS submitted to the network');
  });
});

describe('§4.4.3 chunked image upload', () => {
  /** `method` is PUT for §5.3.5, or POST as the SIM800L sends it (Appendix E.1). */
  const uploadScene = async (method: 'PUT' | 'POST' = 'PUT') => {
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

    const eventId = randomUUID();
    const upsert = await ctx.app.inject(
      signedRequest(ctx, device, {
        method,
        path: `/d/v1/incidents/${eventId}`,
        body: incidentBody(ctx, {
          eventId,
          rentalId: body.id as string,
          assignmentVersion: body.assignmentVersion as number,
        }),
      }),
    );
    expect(upsert.statusCode).toBe(200);

    return { owner, device, eventId };
  };

  /** Uploads `image` in 2 KB chunks, as Appendix E.1.5 specifies. */
  const upload = async (
    device: Awaited<ReturnType<typeof createDevice>>,
    eventId: string,
    image: Buffer,
    declaredSha: string,
    method: 'PUT' | 'POST' = 'PUT',
  ) => {
    const chunkSize = 2048;

    const session = await ctx.app.inject(
      signedRequest(ctx, device, {
        method: 'POST',
        path: `/d/v1/incidents/${eventId}/image/session`,
        body: { schema: 1, bytes: image.length, sha256: declaredSha, chunkSize, mime: 'image/jpeg' },
      }),
    );
    expect(session.statusCode).toBe(200);

    const sessionId = session.json().sessionId as string;
    let offset = session.json().nextOffset as number;

    while (offset < image.length) {
      const chunk = image.subarray(offset, Math.min(offset + chunkSize, image.length));
      const put = await ctx.app.inject(
        signedRequest(ctx, device, {
          method,
          path: `/d/v1/images/${sessionId}/chunks/${offset}`,
          rawBody: chunk,
        }),
      );
      expect(put.statusCode).toBe(200);
      offset = put.json().nextOffset as number;
    }

    const complete = await ctx.app.inject(
      signedRequest(ctx, device, {
        method: 'POST',
        path: `/d/v1/images/${sessionId}/complete`,
        body: {},
      }),
    );

    return { sessionId, complete };
  };

  it('accepts a correct upload and serves it through a signed URL', async () => {
    const { owner, device, eventId } = await uploadScene();

    // A JPEG-shaped payload: SOI ... EOI, like the camera produces.
    const image = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      randomBytes(4000),
      Buffer.from([0xff, 0xd9]),
    ]);
    const sha = createHash('sha256').update(image).digest('hex');

    const { complete } = await upload(device, eventId, image, sha);

    expect(complete.statusCode).toBe(200);
    expect(complete.json()).toMatchObject({ state: 'COMPLETE', sha256: sha, bytes: image.length });

    const incident = await ctx.prisma.incident.findUniqueOrThrow({ where: { id: eventId } });
    expect(incident.photoStatus).toBe('AVAILABLE');
    // §5.6.5: the integrity hash is recomputed to cover the photo.
    expect(incident.integrityHash).toMatch(/^sha256:[0-9a-f]{64}$/);

    // FR-IMG-02: owner-only, via a short-lived signed URL.
    const urlResponse = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/incidents/${eventId}/image-url`,
      headers: auth(owner.accessToken),
    });
    expect(urlResponse.statusCode).toBe(200);
    expect(urlResponse.json().sha256).toBe(sha);

    const signedUrl = urlResponse.json().url as string;
    const download = await ctx.app.inject({ method: 'GET', url: signedUrl });
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toBe('image/jpeg');
    expect(download.rawPayload.length).toBe(image.length);

    // A tampered signature is a 404, exactly like a missing file.
    const forged = signedUrl.replace(/sig=[0-9a-f]+/, `sig=${'a'.repeat(64)}`);
    expect((await ctx.app.inject({ method: 'GET', url: forged })).statusCode).toBe(404);

    // ...and an expired one too.
    ctx.clock.advanceSeconds(ctx.config.SIGNED_URL_TTL_SEC + 10);
    expect((await ctx.app.inject({ method: 'GET', url: signedUrl })).statusCode).toBe(404);
  });

  it('accepts POST for the incident and every chunk, because the SIM800L cannot send PUT', async () => {
    const { eventId, device } = await uploadScene('POST');
    expect(await ctx.prisma.incident.count({ where: { id: eventId } })).toBe(1);

    const image = Buffer.concat([Buffer.from([0xff, 0xd8]), randomBytes(5000), Buffer.from([0xff, 0xd9])]);
    const sha = createHash('sha256').update(image).digest('hex');
    const { complete } = await upload(device, eventId, image, sha, 'POST');

    expect(complete.json()).toMatchObject({ state: 'COMPLETE', sha256: sha });
    expect((await ctx.prisma.incident.findUniqueOrThrow({ where: { id: eventId } })).photoStatus).toBe('AVAILABLE');
  });

  it('fails the upload when the SHA-256 does not match', async () => {
    const { owner, device, eventId } = await uploadScene();

    const image = Buffer.concat([Buffer.from([0xff, 0xd8]), randomBytes(3000), Buffer.from([0xff, 0xd9])]);
    // The device declares a hash for different bytes: corruption in transit, or
    // a photo swapped for another. Either way it must not be shown.
    const wrongSha = createHash('sha256').update(randomBytes(64)).digest('hex');

    const { complete } = await upload(device, eventId, image, wrongSha);

    expect(complete.statusCode).toBe(200);
    expect(complete.json()).toMatchObject({ state: 'FAILED', sha256: null, reason: 'SHA256_MISMATCH' });

    const incident = await ctx.prisma.incident.findUniqueOrThrow({ where: { id: eventId } });
    expect(incident.photoStatus).toBe('FAILED');

    // Nothing to serve: the owner is told there is no verified photo.
    const urlResponse = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/incidents/${eventId}/image-url`,
      headers: auth(owner.accessToken),
    });
    expect(urlResponse.statusCode).toBe(404);
  });

  it('resumes from the server offset and rejects an out-of-order chunk', async () => {
    const { device, eventId } = await uploadScene();

    const image = Buffer.concat([Buffer.from([0xff, 0xd8]), randomBytes(5000), Buffer.from([0xff, 0xd9])]);
    const sha = createHash('sha256').update(image).digest('hex');
    const chunkSize = 2048;

    const session = await ctx.app.inject(
      signedRequest(ctx, device, {
        method: 'POST',
        path: `/d/v1/incidents/${eventId}/image/session`,
        body: { schema: 1, bytes: image.length, sha256: sha, chunkSize, mime: 'image/jpeg' },
      }),
    );
    const sessionId = session.json().sessionId as string;

    // First chunk lands.
    const first = await ctx.app.inject(
      signedRequest(ctx, device, {
        method: 'PUT',
        path: `/d/v1/images/${sessionId}/chunks/0`,
        rawBody: image.subarray(0, chunkSize),
      }),
    );
    expect(first.json().nextOffset).toBe(chunkSize);

    // A chunk from the wrong place is refused, and says where to resume.
    const skipped = await ctx.app.inject(
      signedRequest(ctx, device, {
        method: 'PUT',
        path: `/d/v1/images/${sessionId}/chunks/${chunkSize * 2}`,
        rawBody: image.subarray(chunkSize * 2, chunkSize * 3),
      }),
    );
    expect(skipped.statusCode).toBe(409);
    expect(skipped.json().details.nextOffset).toBe(chunkSize);

    // Re-sending the previous chunk (our reply was lost) is tolerated.
    const repeat = await ctx.app.inject(
      signedRequest(ctx, device, {
        method: 'PUT',
        path: `/d/v1/images/${sessionId}/chunks/0`,
        rawBody: image.subarray(0, chunkSize),
      }),
    );
    expect(repeat.statusCode).toBe(200);
    expect(repeat.json().nextOffset).toBe(chunkSize);

    // Re-opening the session resumes rather than restarting.
    const resumed = await ctx.app.inject(
      signedRequest(ctx, device, {
        method: 'POST',
        path: `/d/v1/incidents/${eventId}/image/session`,
        body: { schema: 1, bytes: image.length, sha256: sha, chunkSize, mime: 'image/jpeg' },
      }),
    );
    expect(resumed.json().nextOffset).toBe(chunkSize);
  });

  it('refuses an image larger than the hard cap (FR-IMG-01)', async () => {
    const { device, eventId } = await uploadScene();

    const response = await ctx.app.inject(
      signedRequest(ctx, device, {
        method: 'POST',
        path: `/d/v1/incidents/${eventId}/image/session`,
        body: {
          schema: 1,
          bytes: ctx.config.IMAGE_MAX_BYTES + 1,
          sha256: 'a'.repeat(64),
          chunkSize: 2048,
          mime: 'image/jpeg',
        },
      }),
    );

    expect(response.statusCode).toBe(400);
  });
});

describe('FR-INC-10 dead-man detector', () => {
  it('raises DEVICE_OFFLINE_DURING_RENTAL after the silence threshold and closes it on return', async () => {
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

    // One heartbeat, ignition ON, then silence.
    await ctx.app.inject(
      signedRequest(ctx, device, { method: 'POST', path: '/d/v1/heartbeat', body: heartbeatBody(ctx) }),
    );

    // Just under the 90 s threshold: nothing yet.
    ctx.clock.advanceSeconds(ctx.config.DEADMAN_ON_SEC - 10);
    await ctx.app.workers.runOnce('deadMan');
    expect(await ctx.prisma.incident.count({ where: { type: 'DEVICE_OFFLINE_DURING_RENTAL' } })).toBe(0);

    // Past it: the bike has gone quiet mid-ride.
    ctx.clock.advanceSeconds(30);
    await ctx.app.workers.runOnce('deadMan');

    const incident = await ctx.prisma.incident.findFirstOrThrow({
      where: { type: 'DEVICE_OFFLINE_DURING_RENTAL' },
    });
    expect(incident.category).toBe('SECURITY');
    // FR-INC-09/10: no driver question, and the bike cannot send an SMS.
    expect(incident.serverQuestion).toBe(false);
    expect(await ctx.prisma.notification.count({ where: { incidentId: incident.id, kind: 'CONTACT_SMS' } })).toBe(0);
    expect(await ctx.prisma.notification.count({ where: { incidentId: incident.id, kind: 'OWNER_PUSH' } })).toBe(1);

    // A second pass must not raise a duplicate.
    await ctx.app.workers.runOnce('deadMan');
    expect(await ctx.prisma.incident.count({ where: { type: 'DEVICE_OFFLINE_DURING_RENTAL' } })).toBe(1);

    // The device comes back: the alert auto-closes (FR-INC-10).
    await ctx.app.inject(
      signedRequest(ctx, device, { method: 'POST', path: '/d/v1/heartbeat', body: heartbeatBody(ctx) }),
    );

    const closed = await ctx.prisma.incident.findUniqueOrThrow({ where: { id: incident.id } });
    expect(closed.state).toBe('CLOSED');
    expect(closed.closedAt).not.toBeNull();
  });
});
