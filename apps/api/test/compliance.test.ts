/**
 * Compliance gaps found reviewing §5.2 (Must), §5.3.6 (D1-D10) and §5.7.
 *
 * Each `describe` names the requirement it proves, so docs/compliance-checklist.md
 * can cite the test directly. These were written before the fixes and failed
 * against the code as it stood.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assignRental,
  auth,
  createReadyDriver,
  createTestContext,
  createUserDirectly,
  destroyTestContext,
  pairDeviceToBike,
  registerUser,
  resetDatabase,
  TEST_PASSWORD,
  type TestContext,
} from './helpers.js';
import { createDevice, heartbeatBody, incidentBody, signedRequest } from './deviceHelpers.js';

let ctx: TestContext;
let imageDir: string;

beforeAll(async () => {
  imageDir = await mkdtemp(join(tmpdir(), 'crashlink-compliance-'));
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

/** Owner + ready driver + paired device + ACTIVE rental. */
const activeScene = async () => {
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
  return { owner, driver, device, bikeId, rentalId, assignmentVersion: body.assignmentVersion as number };
};

const reportCollision = async (scene: Awaited<ReturnType<typeof activeScene>>, extra: Record<string, unknown> = {}) => {
  // Re-reporting an existing event must use the same id in the path and body.
  const eventId = (extra['eventId'] as string | undefined) ?? randomUUID();
  const response = await ctx.app.inject(
    signedRequest(ctx, scene.device, {
      method: 'PUT',
      path: `/d/v1/incidents/${eventId}`,
      body: incidentBody(ctx, {
        eventId,
        rentalId: scene.rentalId,
        assignmentVersion: scene.assignmentVersion,
        ...extra,
      }),
    }),
  );
  return { eventId, response };
};

const get = (token: string, url: string) =>
  ctx.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: auth(token) });

// ---------------------------------------------------------------------------
// FR-RENT-04 - ENDED on ack, or after 10 min with warning
// ---------------------------------------------------------------------------

describe('FR-RENT-04 ending a rental', () => {
  it('ends an ENDING_SYNC rental after 10 minutes without a device ack, and flags it', async () => {
    const scene = await activeScene();
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/rentals/${scene.rentalId}/end`,
      headers: auth(scene.owner.accessToken),
      payload: { idempotencyKey: randomUUID() },
    });

    // Nine minutes: still waiting for the bike.
    ctx.clock.advanceSeconds(9 * 60);
    await ctx.app.workers.runOnce('commandExpiry');
    expect((await ctx.prisma.rental.findUniqueOrThrow({ where: { id: scene.rentalId } })).state).toBe('ENDING_SYNC');

    ctx.clock.advanceSeconds(2 * 60);
    await ctx.app.workers.runOnce('commandExpiry');

    const rental = await ctx.prisma.rental.findUniqueOrThrow({ where: { id: scene.rentalId } });
    expect(rental.state).toBe('ENDED');
    expect((await ctx.prisma.bike.findUniqueOrThrow({ where: { id: scene.bikeId } })).status).toBe('AVAILABLE');

    // The warning: the owner is told the bike never confirmed it let go.
    const detail = await get(scene.owner.accessToken, `/rentals/${scene.rentalId}`);
    expect(detail.json().endConfirmedByDevice).toBe(false);
    expect(
      await ctx.prisma.auditEvent.count({ where: { action: 'RENTAL_END_TIMEOUT', targetId: scene.rentalId } }),
    ).toBe(1);

    // The bike and the rider are free again.
    const again = await assignRental(ctx, scene.owner, scene.bikeId, scene.driver.id);
    expect(again.statusCode).toBe(201);
  });

  it('reports endConfirmedByDevice=true when the bike acked CLEAR_ASSIGNMENT', async () => {
    const scene = await activeScene();
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/rentals/${scene.rentalId}/end`,
      headers: auth(scene.owner.accessToken),
      payload: { idempotencyKey: randomUUID() },
    });

    const beat = await ctx.app.inject(
      signedRequest(ctx, scene.device, { method: 'POST', path: '/d/v1/heartbeat', body: heartbeatBody(ctx) }),
    );
    const clear = (beat.json().commands as { id: string; type: string }[]).find((c) => c.type === 'CLEAR_ASSIGNMENT');
    expect(clear).toBeDefined();
    await ctx.app.inject(
      signedRequest(ctx, scene.device, {
        method: 'POST',
        path: `/d/v1/commands/${clear!.id}/ack`,
        body: { result: 'APPLIED' },
      }),
    );

    const detail = await get(scene.owner.accessToken, `/rentals/${scene.rentalId}`);
    expect(detail.json().state).toBe('ENDED');
    expect(detail.json().endConfirmedByDevice).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FR-IMG-02 / §5.7.2 - admin reads; guest and admin see masked phones
// ---------------------------------------------------------------------------

describe('§5.7.2 ADMIN read access and FR-IMG-02 admin image access', () => {
  it('lets an ADMIN read any owner\'s bikes, rentals, incidents and image URL, but not change them', async () => {
    const scene = await activeScene();
    const admin = await createUserDirectly(ctx, 'ADMIN');
    const { eventId } = await reportCollision(scene);

    // Upload a verified photo so image-url has something to sign.
    const image = Buffer.concat([Buffer.from([0xff, 0xd8]), randomBytes(1500), Buffer.from([0xff, 0xd9])]);
    const sha = createHash('sha256').update(image).digest('hex');
    const session = await ctx.app.inject(
      signedRequest(ctx, scene.device, {
        method: 'POST',
        path: `/d/v1/incidents/${eventId}/image/session`,
        body: { schema: 1, bytes: image.length, sha256: sha, chunkSize: 2048, mime: 'image/jpeg' },
      }),
    );
    const sessionId = session.json().sessionId as string;
    await ctx.app.inject(
      signedRequest(ctx, scene.device, { method: 'PUT', path: `/d/v1/images/${sessionId}/chunks/0`, rawBody: image }),
    );
    await ctx.app.inject(
      signedRequest(ctx, scene.device, { method: 'POST', path: `/d/v1/images/${sessionId}/complete`, body: {} }),
    );

    expect((await get(admin.accessToken, '/bikes')).json().items).toHaveLength(1);
    expect((await get(admin.accessToken, `/bikes/${scene.bikeId}`)).statusCode).toBe(200);
    expect((await get(admin.accessToken, '/rentals')).json().items).toHaveLength(1);
    expect((await get(admin.accessToken, `/rentals/${scene.rentalId}`)).statusCode).toBe(200);
    expect((await get(admin.accessToken, '/incidents')).json().items).toHaveLength(1);
    expect((await get(admin.accessToken, `/incidents/${eventId}`)).statusCode).toBe(200);
    // FR-IMG-02: "to the owning owner (and admin)".
    expect((await get(admin.accessToken, `/incidents/${eventId}/image-url`)).statusCode).toBe(200);
    expect((await get(admin.accessToken, '/analytics/incidents-by-type')).statusCode).toBe(200);

    // Read, not write.
    const ack = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/incidents/${eventId}/acknowledge`,
      headers: auth(admin.accessToken),
      payload: {},
    });
    expect(ack.statusCode).toBe(403);
  });

  it('masks every phone number for GUEST and ADMIN; only the owner sees full numbers', async () => {
    const scene = await activeScene();
    await ctx.prisma.user.update({ where: { id: scene.owner.id }, data: { isDemo: true } });
    const guest = await createUserDirectly(ctx, 'GUEST', { isDemo: true });
    const admin = await createUserDirectly(ctx, 'ADMIN');
    const { eventId } = await reportCollision(scene);

    const ownerView = (await get(scene.owner.accessToken, `/incidents/${eventId}`)).json();
    expect(ownerView.contact.phone).toMatch(/^\+\d+$/);

    for (const [who, token] of [['guest', guest.accessToken], ['admin', admin.accessToken]] as const) {
      const incident = (await get(token, `/incidents/${eventId}`)).json();
      expect(incident.contact.phone, who).toMatch(/•/);
      expect(incident.rental.driverPhone, who).toMatch(/•/);

      const rental = await get(token, `/rentals/${scene.rentalId}`);
      expect(rental.statusCode, who).toBe(200);
      for (const phone of [rental.json().snapshot.ownerPhone, rental.json().snapshot.contactPhone]) {
        expect(phone, who).toMatch(/•/);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// FR-IMG-03 - photo status shown, including UPLOADING (%)
// ---------------------------------------------------------------------------

describe('FR-IMG-03 photo status and progress', () => {
  it('reports PENDING before any upload session exists', async () => {
    const scene = await activeScene();
    const { eventId } = await reportCollision(scene, { photoStatus: 'PENDING' });

    const photo = (await get(scene.owner.accessToken, `/incidents/${eventId}`)).json().photo;
    expect(photo).toMatchObject({ status: 'PENDING', progress: null });
  });

  it('reports UPLOADING with a real percentage', async () => {
    const scene = await activeScene();
    const { eventId } = await reportCollision(scene);
    const image = randomBytes(4096);
    const sha = createHash('sha256').update(image).digest('hex');

    const session = await ctx.app.inject(
      signedRequest(ctx, scene.device, {
        method: 'POST',
        path: `/d/v1/incidents/${eventId}/image/session`,
        body: { schema: 1, bytes: 4096, sha256: sha, chunkSize: 2048, mime: 'image/jpeg' },
      }),
    );
    await ctx.app.inject(
      signedRequest(ctx, scene.device, {
        method: 'PUT',
        path: `/d/v1/images/${session.json().sessionId as string}/chunks/0`,
        rawBody: image.subarray(0, 1024),
      }),
    );

    const photo = (await get(scene.owner.accessToken, `/incidents/${eventId}`)).json().photo;
    expect(photo.status).toBe('UPLOADING');
    expect(photo.progress).toBeCloseTo(0.25, 5);
  });
});

// ---------------------------------------------------------------------------
// §5.7.1 - per-account login lockout; §5.7.3 - login audited
// ---------------------------------------------------------------------------

describe('§5.7.1 login throttling per account', () => {
  it('locks the account after 5 failed logins in 15 minutes, even for the right password', async () => {
    const user = await registerUser(ctx, 'OWNER');
    const login = (password: string) =>
      ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { identifier: user.email, password },
      });

    for (let i = 0; i < 5; i += 1) expect((await login('wrong-password')).statusCode).toBe(401);

    const locked = await login(TEST_PASSWORD);
    expect(locked.statusCode).toBe(429);
    expect(locked.json().code).toBe('RATE_LIMITED');

    // The window is rolling: 15 minutes later the account works again.
    ctx.clock.advanceSeconds(15 * 60 + 1);
    expect((await login(TEST_PASSWORD)).statusCode).toBe(200);

    // §5.7.3: logins are audited, with no password or phone in the metadata.
    expect(await ctx.prisma.auditEvent.count({ where: { action: 'LOGIN_FAILED', targetId: user.id } })).toBe(5);
    expect(await ctx.prisma.auditEvent.count({ where: { action: 'LOGIN_SUCCEEDED', targetId: user.id } })).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// §5.7.4 - per-device rate limit and body limit
// ---------------------------------------------------------------------------

describe('§5.7.4 device flooding and oversized payloads', () => {
  it('limits a device to 60 authenticated requests per minute', async () => {
    const device = await createDevice(ctx);
    const beat = () =>
      ctx.app.inject(signedRequest(ctx, device, { method: 'POST', path: '/d/v1/heartbeat', body: heartbeatBody(ctx) }));

    for (let i = 0; i < 60; i += 1) expect((await beat()).statusCode).toBe(200);
    const sixtyFirst = await beat();
    expect(sixtyFirst.statusCode).toBe(429);
    expect(sixtyFirst.json().code).toBe('RATE_LIMITED');

    ctx.clock.advanceSeconds(61);
    expect((await beat()).statusCode).toBe(200);
  });

  it('rejects a device body over 32 KB with PAYLOAD_TOO_LARGE', async () => {
    const device = await createDevice(ctx);
    const response = await ctx.app.inject(
      signedRequest(ctx, device, {
        method: 'POST',
        path: '/d/v1/heartbeat',
        body: { ...heartbeatBody(ctx), padding: 'x'.repeat(33 * 1024) },
      }),
    );
    expect(response.statusCode).toBe(413);
    expect(response.json().code).toBe('PAYLOAD_TOO_LARGE');
  });
});

// ---------------------------------------------------------------------------
// D6, D8, D9
// ---------------------------------------------------------------------------

describe('D6 bike SOS button', () => {
  it('escalates a device MANUAL_SOS immediately: HELP, one CONTACT_SMS, no question', async () => {
    const scene = await activeScene();
    const { eventId, response } = await reportCollision(scene, { type: 'MANUAL_SOS' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ state: 'ESCALATED', decision: 'HELP', serverQuestion: false });
    expect(await ctx.prisma.notification.count({ where: { incidentId: eventId, kind: 'CONTACT_SMS' } })).toBe(1);
    expect(await ctx.prisma.notification.count({ where: { incidentId: eventId, kind: 'DRIVER_PROMPT' } })).toBe(0);
  });
});

describe('D8 both facts are shown', () => {
  it('records the bike\'s offline escalation on the timeline when the server had already decided SAFE', async () => {
    const scene = await activeScene();
    const { eventId } = await reportCollision(scene);

    ctx.clock.advanceSeconds(20);
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/incidents/${eventId}/responses`,
      headers: auth(scene.driver.accessToken),
      payload: { choice: 'SAFE', idempotencyKey: randomUUID() },
    });

    ctx.clock.advanceSeconds(60);
    await reportCollision(scene, {
      eventId,
      localDecision: {
        decision: 'OFFLINE_FALLBACK',
        source: 'DEVICE_OFFLINE_TIMER',
        decidedAt: ctx.clock.now().toISOString(),
      },
    });

    const detail = (await get(scene.owner.accessToken, `/incidents/${eventId}`)).json();
    expect(detail.decision).toBe('SAFE');
    const events = (detail.timeline as { event: string; text: string }[]).map((entry) => entry.event);
    expect(events).toContain('DECIDED');
    expect(events).toContain('DEVICE_LOCAL_DECISION');
  });
});

describe('D9 local Safe with no active incident', () => {
  it('is logged as informational', async () => {
    const device = await createDevice(ctx);
    const response = await ctx.app.inject(
      signedRequest(ctx, device, {
        method: 'POST',
        path: `/d/v1/incidents/${randomUUID()}/local-response`,
        body: { choice: 'SAFE', deviceTime: ctx.clock.now().toISOString(), idempotencyKey: randomUUID() },
      }),
    );
    expect(response.json().accepted).toBe(false);
    expect(
      await ctx.prisma.auditEvent.count({ where: { action: 'DEVICE_LOCAL_RESPONSE_NO_INCIDENT', targetId: device.id } }),
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// NFR-11 - /admin/health
// ---------------------------------------------------------------------------

describe('NFR-11 / FR-ADM-01 GET /admin/health', () => {
  it('reports db, workers, stale devices and pending commands to an admin only', async () => {
    const scene = await activeScene();
    const admin = await createUserDirectly(ctx, 'ADMIN');
    await ctx.app.workers.runOnce('deadline');

    const response = await get(admin.accessToken, '/admin/health');
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.db).toBe('ok');
    expect(body.workers.deadline.lastRunAt).not.toBeNull();
    expect(body.workers.deadline.intervalMs).toBe(1000);
    // The paired device has never reported, so it is stale.
    expect(body.staleDevices).toContain(scene.device.code);
    // SET_ASSIGNMENT is still waiting for the bike.
    expect(body.pendingCommands).toBeGreaterThanOrEqual(1);
    expect(typeof body.version).toBe('string');

    expect((await get(scene.owner.accessToken, '/admin/health')).statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Appendix E.1.3 / NFR-12 - device responses stay under 1 KB
// ---------------------------------------------------------------------------

describe('NFR-12 device payload budget', () => {
  it('keeps every /d/v1 response under 1 KB by pacing commands, and still delivers them all in order', async () => {
    const scene = await activeScene();
    const deviceRow = await ctx.prisma.device.findUniqueOrThrow({ where: { code: scene.device.code } });
    const config = deviceRow.config as Record<string, unknown>;

    // A full SET_CONFIG is large; queue several behind the SET_ASSIGNMENT.
    for (let version = 2; version <= 4; version += 1) {
      await ctx.prisma.deviceCommand.create({
        data: {
          deviceId: deviceRow.id,
          type: 'SET_CONFIG',
          payload: { ...config, configVersion: version },
          expiresAt: new Date(ctx.clock.now().getTime() + 3_600_000),
        },
      });
    }

    const delivered: string[] = [];
    for (let beat = 0; beat < 6 && delivered.length < 4; beat += 1) {
      const response = await ctx.app.inject(
        signedRequest(ctx, scene.device, { method: 'POST', path: '/d/v1/heartbeat', body: heartbeatBody(ctx) }),
      );
      expect(response.rawPayload.length).toBeLessThan(1024);
      for (const command of response.json().commands as { id: string; type: string }[]) {
        if (!delivered.includes(command.id)) delivered.push(command.id);
        await ctx.app.inject(
          signedRequest(ctx, scene.device, {
            method: 'POST',
            path: `/d/v1/commands/${command.id}/ack`,
            body: { result: 'APPLIED' },
          }),
        );
      }
    }

    expect(delivered).toHaveLength(4);
  });

  it('fits a maximal heartbeat (10 fixes, 5 events) in 4 KB', () => {
    const t = '2026-09-21T06:30:05Z';
    const body = {
      ...heartbeatBody(ctx),
      ignitionEvents: [{ state: 'ON', t }],
      fixes: Array.from({ length: 10 }, () => ({
        t,
        lat: 6.914731,
        lon: 79.972912,
        spd: 18.4,
        hdop: 1.1,
        sat: 7,
        valid: true,
        src: 'GPS',
      })),
      events: Array.from({ length: 5 }, () => ({
        eventId: randomUUID(),
        type: 'POSSIBLE_DANGEROUS_CORNERING',
        t,
        evidence: { leanDeg: 38.2, durationMs: 1400, speedKph: 22.5, simulated: false },
        lat: 6.914731,
        lon: 79.972912,
      })),
    };
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThanOrEqual(4096);
  });
});

// ---------------------------------------------------------------------------
// NFR-04 - labels
// ---------------------------------------------------------------------------

describe('NFR-04 honest labels', () => {
  it('begins every incident label with "Possible", except SOS and device-offline', async () => {
    const { INCIDENT_TYPE_LABELS } = await import('@crashlink/contracts');
    for (const [type, label] of Object.entries(INCIDENT_TYPE_LABELS)) {
      if (type === 'MANUAL_SOS' || type === 'DEVICE_OFFLINE_DURING_RENTAL') continue;
      expect(label, type).toMatch(/^Possible /);
    }
  });
});
