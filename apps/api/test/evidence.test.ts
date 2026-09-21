/**
 * Evidence for requirements that were already met but had nothing proving
 * them. Each describe names the requirement docs/compliance-checklist.md cites.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { FakeClock } from '../src/lib/time.js';
import { distanceIncrement } from '../src/lib/geo.js';
import { maskObject, maskPhone, maskPhonesInText } from '../src/lib/mask.js';
import { deviceOnlineState } from '../src/modules/bikes/service.js';
import { sha256Hex } from '../src/lib/crypto.js';
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
// Pure units
// ---------------------------------------------------------------------------

describe('FR-MON-02 online / stale / offline (§2.3.3)', () => {
  const now = new Date('2026-09-21T06:30:00Z');
  const ago = (sec: number) => new Date(now.getTime() - sec * 1000);
  const config = { telemetryOnSec: 10, telemetryOffSec: 60 };

  it('uses 2.5x / 5x the ON interval (10 s -> 25 s / 50 s)', () => {
    expect(deviceOnlineState(ago(25), true, config, now)).toBe('ONLINE');
    expect(deviceOnlineState(ago(26), true, config, now)).toBe('STALE');
    expect(deviceOnlineState(ago(50), true, config, now)).toBe('STALE');
    expect(deviceOnlineState(ago(51), true, config, now)).toBe('OFFLINE');
  });

  it('uses the OFF interval when parked (60 s -> 150 s / 300 s)', () => {
    expect(deviceOnlineState(ago(150), false, config, now)).toBe('ONLINE');
    expect(deviceOnlineState(ago(151), false, config, now)).toBe('STALE');
    expect(deviceOnlineState(ago(301), false, config, now)).toBe('OFFLINE');
  });

  it('is OFFLINE for a device that has never reported', () => {
    expect(deviceOnlineState(null, true, config, now)).toBe('OFFLINE');
  });
});

describe('FR-RENT-05 trip distance plausibility (§5.6.5)', () => {
  const anchor = { lat: 6.914, lon: 79.9729, at: new Date('2026-09-21T06:30:00Z') };
  const later = (sec: number) => new Date(anchor.at.getTime() + sec * 1000);

  it('adds a plausible move', () => {
    const metres = distanceIncrement(anchor, { lat: 6.915, lon: 79.9729, fixAt: later(30), hdop: 1, valid: true });
    expect(metres).toBeGreaterThan(100);
    expect(metres).toBeLessThan(120);
  });

  it('ignores jitter under 5 m', () => {
    expect(distanceIncrement(anchor, { lat: 6.91402, lon: 79.9729, fixAt: later(10), hdop: 1, valid: true })).toBeNull();
  });

  it('rejects an implied speed over 150 km/h', () => {
    // ~1.1 km in 10 s = ~400 km/h: a bad fix, not a fast bike.
    expect(distanceIncrement(anchor, { lat: 6.924, lon: 79.9729, fixAt: later(10), hdop: 1, valid: true })).toBeNull();
  });

  it('rejects HDOP over 5 and invalid fixes', () => {
    expect(distanceIncrement(anchor, { lat: 6.915, lon: 79.9729, fixAt: later(30), hdop: 6, valid: true })).toBeNull();
    expect(distanceIncrement(anchor, { lat: 6.915, lon: 79.9729, fixAt: later(30), hdop: 1, valid: false })).toBeNull();
  });
});

describe('§5.7.3 phone masking in logs and metadata', () => {
  it('masks E.164 numbers to +94•••••4567', () => {
    expect(maskPhone('+94771234567')).toBe('+94•••••4567');
    expect(maskPhonesInText('SMS to +94771234567 failed')).toBe('SMS to +94•••••4567 failed');
  });

  it('masks phone fields and drops secrets from structured log objects', () => {
    const masked = maskObject({
      contactPhone: '+94712223344',
      nested: { note: 'call +94771234567' },
      password: 'hunter22',
      refreshToken: 'abc',
      sig: 'f'.repeat(64),
    }) as Record<string, unknown>;

    expect(masked['contactPhone']).toBe('+94•••••3344');
    expect((masked['nested'] as { note: string }).note).toBe('call +94•••••4567');
    expect(masked['password']).toBe('[redacted]');
    expect(masked['refreshToken']).toBe('[redacted]');
    expect(masked['sig']).toBe('[redacted]');
  });
});

// ---------------------------------------------------------------------------
// App-level
// ---------------------------------------------------------------------------

let ctx: TestContext;
let imageDir: string;

beforeAll(async () => {
  imageDir = await mkdtemp(join(tmpdir(), 'crashlink-evidence-'));
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

describe('NFR-05 RBAC on every endpoint', () => {
  /** The only routes that may be reached without a bearer token or HMAC. */
  const PUBLIC = new Set([
    'GET /health',
    'POST /api/v1/auth/register',
    'POST /api/v1/auth/login',
    'POST /api/v1/auth/refresh',
    'POST /api/v1/auth/guest',
    // Signed URL: authorised by its own HMAC, checked in its own test.
    'GET /api/v1/files/images/*',
    // §5.3.2: the unsigned clock bootstrap.
    'GET /d/v1/time',
  ]);

  it('refuses every non-public route without credentials', async () => {
    const routes = ctx.app.routeTable.filter(
      (route) => route.method !== 'HEAD' && route.method !== 'OPTIONS' && !PUBLIC.has(`${route.method} ${route.url}`),
    );

    // Sanity: the table really covers the API, so an empty sweep cannot pass.
    expect(routes.length).toBeGreaterThan(40);

    const unprotected: string[] = [];
    for (const route of routes) {
      const url = route.url
        .replace(/:[A-Za-z]+/g, randomUUID())
        .replace('*', 'x');
      const response = await ctx.app.inject({ method: route.method as 'GET', url });

      const expected = route.url.startsWith('/d/v1') ? 'BAD_SIGNATURE' : 'UNAUTHORIZED';
      if (response.statusCode !== 401 || response.json().code !== expected) {
        unprotected.push(`${route.method} ${route.url} -> ${response.statusCode}`);
      }
    }

    expect(unprotected).toEqual([]);
  });
});

describe('§5.7.1 token and password parameters', () => {
  it('signs HS256 access tokens for 1 h with sub, role and isDemo', async () => {
    const user = await registerUser(ctx, 'OWNER');
    // Header and payload only - the third segment is the binary signature.
    const [header, payload] = user.accessToken.split('.').slice(0, 2).map((part) =>
      JSON.parse(Buffer.from(part, 'base64url').toString('utf8')),
    ) as [{ alg: string }, { sub: string; role: string; isDemo: boolean; iat: number; exp: number }];

    expect(header.alg).toBe('HS256');
    expect(payload).toMatchObject({ sub: user.id, role: 'OWNER', isDemo: false });
    expect(payload.exp - payload.iat).toBe(3600);
  });

  it('hashes passwords with bcrypt cost 10 and keeps refresh tokens 30 days, hashed', async () => {
    const user = await registerUser(ctx, 'DRIVER');
    const row = await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.passwordHash).toMatch(/^\$2[aby]\$10\$/);

    const token = await ctx.prisma.refreshToken.findUniqueOrThrow({
      where: { tokenHash: sha256Hex(user.refreshToken) },
    });
    const days = (token.expiresAt.getTime() - ctx.clock.now().getTime()) / 86_400_000;
    expect(days).toBeCloseTo(30, 5);
    // 32 random bytes as hex, never stored in the clear.
    expect(user.refreshToken).toMatch(/^[0-9a-f]{64}$/);
    expect(token.tokenHash).not.toBe(user.refreshToken);
  });
});

describe('FR-DEV-04 device health on bike detail', () => {
  it('shows every health field after a heartbeat, battery always null (M10)', async () => {
    const owner = await registerUser(ctx, 'OWNER');
    const device = await createDevice(ctx);
    const bikeId = await pairDeviceToBike(ctx, owner, device);

    await ctx.app.inject(
      signedRequest(ctx, device, { method: 'POST', path: '/d/v1/heartbeat', body: heartbeatBody(ctx) }),
    );

    const detail = (
      await ctx.app.inject({ method: 'GET', url: `/api/v1/bikes/${bikeId}`, headers: auth(owner.accessToken) })
    ).json();

    expect(detail.device).toMatchObject({ code: device.code, online: 'ONLINE', configPending: false });
    expect(detail.device.lastSeenAt).toBe(ctx.clock.now().toISOString());
    expect(detail.health).toMatchObject({
      csq: 17,
      signalBars: 3,
      gprs: true,
      gpsFix: true,
      sats: 7,
      hdop: 1.1,
      cameraLink: true,
      batteryV: null,
      queuedJobs: 0,
      fw: '1.0.0',
    });
  });
});

describe('FR-DRV-02 / FR-DRV-03 the driver\'s own views', () => {
  it('shows the active rental with start, distance, ignition, freshness and connectivity', async () => {
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

    const rental = (
      await ctx.app.inject({ method: 'GET', url: '/api/v1/drivers/me/active-rental', headers: auth(driver.accessToken) })
    ).json().rental;

    expect(rental.startedAt).not.toBeNull();
    expect(typeof rental.distanceM).toBe('number');
    expect(rental.bike.ignition.state).toBeDefined();
    expect(rental.bike.location.kind).toBeDefined();
    expect(rental.bike.deviceOnline).toBeDefined();
    // §5.7.3: the driver never gets the owner's full number.
    expect(rental.ownerPhone).toMatch(/•/);
  });

  it('never gives a driver photo fields, in the list or the detail', async () => {
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
        body: incidentBody(ctx, { eventId, rentalId: body.id as string, assignmentVersion: body.assignmentVersion as number }),
      }),
    );

    const list = (
      await ctx.app.inject({ method: 'GET', url: '/api/v1/drivers/me/incidents', headers: auth(driver.accessToken) })
    ).json();
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).not.toHaveProperty('photoStatus');

    const detail = (
      await ctx.app.inject({ method: 'GET', url: `/api/v1/incidents/${eventId}`, headers: auth(driver.accessToken) })
    ).json();
    expect(detail.photo).toBeNull();

    // And the image URL is refused outright (§5.7.2 Images: DRIVER ✗).
    const url = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/incidents/${eventId}/image-url`,
      headers: auth(driver.accessToken),
    });
    expect(url.statusCode).toBe(403);
  });
});

describe('NFR-06 retention (§5.6.6)', () => {
  it('deletes locations after 30 d, audit after 180 d and photos after 90 d - and says so honestly', async () => {
    const owner = await registerUser(ctx, 'OWNER');
    const device = await createDevice(ctx);
    const bikeId = await pairDeviceToBike(ctx, owner, device);
    const now = ctx.clock.now();
    const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);

    await ctx.prisma.locationSample.createMany({
      data: [
        { bikeId, fixAt: daysAgo(31), lat: 6.9, lon: 79.9, valid: true },
        { bikeId, fixAt: daysAgo(29), lat: 6.9, lon: 79.9, valid: true },
      ],
    });
    await ctx.prisma.auditEvent.createMany({
      data: [
        { actorType: 'SYSTEM', action: 'OLD', createdAt: daysAgo(181) },
        { actorType: 'SYSTEM', action: 'RECENT', createdAt: daysAgo(10) },
      ],
    });

    const incident = await ctx.prisma.incident.create({
      data: {
        id: randomUUID(),
        bikeId,
        ownerId: owner.id,
        type: 'POSSIBLE_COLLISION',
        category: 'EMERGENCY',
        state: 'CLOSED',
        occurredAt: daysAgo(95),
        timeSource: 'GPS',
        locationKind: 'UNAVAILABLE',
        evidence: {},
        photoStatus: 'AVAILABLE',
      },
    });
    const storageKey = `2026/06/${incident.id}.jpg`;
    const path = join(imageDir, storageKey);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, randomBytes(100));
    await ctx.prisma.incidentImage.create({
      data: {
        incidentId: incident.id,
        state: 'COMPLETE',
        expectedBytes: 100,
        receivedBytes: 100,
        chunkSize: 2048,
        sha256Expected: 'a'.repeat(64),
        sha256Actual: 'a'.repeat(64),
        storageKey,
        completedAt: daysAgo(91),
      },
    });

    await ctx.app.workers.runOnce('retention');

    expect(await ctx.prisma.locationSample.count({ where: { bikeId } })).toBe(1);
    expect(await ctx.prisma.auditEvent.count({ where: { action: 'OLD' } })).toBe(0);
    expect(await ctx.prisma.auditEvent.count({ where: { action: 'RECENT' } })).toBe(1);
    expect(existsSync(path)).toBe(false);

    // The photo is gone, and the detail says so - it does not claim none was taken.
    const detail = (
      await ctx.app.inject({ method: 'GET', url: `/api/v1/incidents/${incident.id}`, headers: auth(owner.accessToken) })
    ).json();
    expect(detail.photo).toMatchObject({ status: 'AVAILABLE', expired: true });
  });
});

// ---------------------------------------------------------------------------
// FR-NOT-03 / NFR-01 - realtime over a real Socket.IO connection
// ---------------------------------------------------------------------------

describe('FR-NOT-03 realtime rooms and NFR-01 latency', () => {
  it('delivers incident.created to the owner and incident.question to the driver within 2 s, and to nobody else', async () => {
    // A separate app with the real Socket.IO plugin and a listening port.
    const prisma = new PrismaClient();
    const clock = new FakeClock('2026-09-21T06:30:00.000Z');
    const live = await buildApp({ config: loadConfig(), clock, prisma, enableSockets: true, enableWorkers: false });
    await live.listen({ port: 0, host: '127.0.0.1' });
    const port = (live.server.address() as { port: number }).port;

    const liveCtx = { ...ctx, app: live, prisma, clock } as TestContext;
    const sockets: Socket[] = [];

    try {
      const owner = await registerUser(liveCtx, 'OWNER');
      const stranger = await registerUser(liveCtx, 'OWNER');
      const driver = await createReadyDriver(liveCtx);
      const device = await createDevice(liveCtx);
      const bikeId = await pairDeviceToBike(liveCtx, owner, device);
      const { body } = await assignRental(liveCtx, owner, bikeId, driver.id);
      await live.inject({
        method: 'POST',
        url: `/api/v1/rentals/${body.id as string}/force-activate`,
        headers: auth(owner.accessToken),
        payload: { confirm: true },
      });

      const open = (token: string) =>
        new Promise<Socket>((resolve, reject) => {
          const socket = connect(`http://127.0.0.1:${port}`, {
            path: '/socket.io',
            auth: { token },
            transports: ['websocket'],
            reconnection: false,
          });
          sockets.push(socket);
          socket.on('connect', () => resolve(socket));
          socket.on('connect_error', reject);
        });

      const [ownerSocket, driverSocket, strangerSocket] = await Promise.all([
        open(owner.accessToken),
        open(driver.accessToken),
        open(stranger.accessToken),
      ]);

      const strangerEvents: string[] = [];
      strangerSocket.onAny((event: string) => strangerEvents.push(event));

      const created = new Promise<number>((resolve) => ownerSocket.once('incident.created', () => resolve(Date.now())));
      const question = new Promise<number>((resolve) =>
        driverSocket.once('incident.question', () => resolve(Date.now())),
      );

      const eventId = randomUUID();
      const sentAt = Date.now();
      await live.inject(
        signedRequest(liveCtx, device, {
          method: 'PUT',
          path: `/d/v1/incidents/${eventId}`,
          body: incidentBody(liveCtx, {
            eventId,
            rentalId: body.id as string,
            assignmentVersion: body.assignmentVersion as number,
          }),
        }),
      );

      const [createdAt, questionAt] = await Promise.all([created, question]);
      // NFR-01: device PUT -> owner realtime update <= 2 s server side.
      expect(createdAt - sentAt).toBeLessThan(2000);
      expect(questionAt - sentAt).toBeLessThan(2000);

      // Rooms are per user: another owner hears nothing about this bike.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(strangerEvents).not.toContain('incident.created');

      // A bad token cannot join at all.
      await expect(open('not-a-token')).rejects.toBeTruthy();
    } finally {
      for (const socket of sockets) socket.close();
      await live.close();
      await prisma.$disconnect();
    }
  });
});
