/**
 * §5.4.7 analytics & dashboard.
 *
 * Rows are inserted directly so each test controls exactly what exists. The
 * clock is fixed at 2026-09-21T06:30Z, which is 12:00 in Asia/Colombo, so the
 * owner's "today" began at 2026-09-20T18:30Z.
 */
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  auth,
  createTestContext,
  createUserDirectly,
  destroyTestContext,
  registerUser,
  resetDatabase,
  type TestContext,
  type TestUser,
} from './helpers.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await destroyTestContext(ctx);
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  ctx.clock.set('2026-09-21T06:30:00.000Z');
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const createBike = async (ownerId: string, label: string) =>
  ctx.prisma.bike.create({ data: { ownerId, label } });

let incidentSeq = 0;

const createIncident = async (input: {
  ownerId: string;
  bikeId: string;
  type: Prisma.IncidentCreateInput['type'];
  category: Prisma.IncidentCreateInput['category'];
  occurredAt: string;
  state?: Prisma.IncidentCreateInput['state'];
  decision?: Prisma.IncidentCreateInput['decision'];
  questionSentAt?: string | null;
  lat?: number | null;
  lon?: number | null;
  evidence?: Record<string, unknown>;
}) => {
  incidentSeq += 1;
  return ctx.prisma.incident.create({
    data: {
      id: randomUUID(),
      bikeId: input.bikeId,
      ownerId: input.ownerId,
      type: input.type,
      category: input.category,
      state: input.state ?? 'CLOSED',
      decision: input.decision ?? 'NOT_APPLICABLE',
      occurredAt: new Date(input.occurredAt),
      receivedAt: new Date(input.occurredAt),
      timeSource: 'GPS',
      locationKind: input.lat != null ? 'LIVE' : 'UNAVAILABLE',
      lat: input.lat ?? null,
      lon: input.lon ?? null,
      evidence: (input.evidence ?? { simulated: false, seq: incidentSeq }) as Prisma.InputJsonValue,
      serverQuestion: Boolean(input.questionSentAt),
      questionSentAt: input.questionSentAt ? new Date(input.questionSentAt) : null,
      responseDeadlineAt: input.questionSentAt
        ? new Date(new Date(input.questionSentAt).getTime() + 60_000)
        : null,
    },
  });
};

/** An ENDED rental, so the one-open-rental indexes never get in the way. */
const createEndedRental = async (input: {
  ownerId: string;
  bikeId: string;
  startedAt: string;
  distanceMeters: number;
}) => {
  const driver = await ctx.prisma.user.create({
    data: {
      role: 'DRIVER',
      name: 'Rider',
      email: `rider-${randomUUID()}@test.lk`,
      passwordHash: await bcrypt.hash('x', 4),
    },
  });
  const contact = await ctx.prisma.emergencyContact.create({
    data: { driverId: driver.id, name: 'Diroshan', phoneE164: '+94771112222', relationship: 'Mother' },
  });
  const version = (await ctx.prisma.rental.count({ where: { bikeId: input.bikeId } })) + 1;

  return ctx.prisma.rental.create({
    data: {
      bikeId: input.bikeId,
      driverId: driver.id,
      ownerId: input.ownerId,
      emergencyContactId: contact.id,
      ownerPhoneSnapshot: '+94770000001',
      driverNameSnapshot: 'Rider',
      contactNameSnapshot: 'Diroshan',
      contactPhoneSnapshot: '+94771112222',
      state: 'ENDED',
      assignmentVersion: version,
      startedAt: new Date(input.startedAt),
      endedAt: new Date(new Date(input.startedAt).getTime() + 3_600_000),
      distanceMeters: input.distanceMeters,
    },
  });
};

const get = (owner: { accessToken: string }, url: string) =>
  ctx.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: auth(owner.accessToken) });

// ---------------------------------------------------------------------------
// Range validation
// ---------------------------------------------------------------------------

describe('?from&to validation', () => {
  it('refuses a reversed range, an over-long range and a malformed date', async () => {
    const owner = await registerUser(ctx, 'OWNER');

    const reversed = await get(owner, '/analytics/incidents-by-type?from=2026-09-21T00:00:00Z&to=2026-09-01T00:00:00Z');
    expect(reversed.statusCode).toBe(400);
    expect(reversed.json().code).toBe('VALIDATION_FAILED');

    const tooLong = await get(owner, '/analytics/incidents-by-type?from=2025-01-01T00:00:00Z&to=2026-09-21T00:00:00Z');
    expect(tooLong.statusCode).toBe(400);

    const malformed = await get(owner, '/analytics/incidents-by-type?from=yesterday');
    expect(malformed.statusCode).toBe(400);
  });

  it('only accepts bucket=day for the timeseries', async () => {
    const owner = await registerUser(ctx, 'OWNER');
    expect((await get(owner, '/analytics/incidents-timeseries?bucket=day')).statusCode).toBe(200);
    expect((await get(owner, '/analytics/incidents-timeseries?bucket=week')).statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// incidents-by-type
// ---------------------------------------------------------------------------

describe('GET /analytics/incidents-by-type', () => {
  it('counts by type within the range, most frequent first, scoped to the owner', async () => {
    const owner = await registerUser(ctx, 'OWNER');
    const other = await registerUser(ctx, 'OWNER');
    const bike = await createBike(owner.id, 'Scooter 1');
    const otherBike = await createBike(other.id, 'Other');

    for (let i = 0; i < 3; i += 1) {
      await createIncident({ ownerId: owner.id, bikeId: bike.id, type: 'POSSIBLE_POTHOLE', category: 'INFO', occurredAt: '2026-09-20T08:00:00Z' });
    }
    await createIncident({ ownerId: owner.id, bikeId: bike.id, type: 'POSSIBLE_COLLISION', category: 'EMERGENCY', occurredAt: '2026-09-19T08:00:00Z' });
    // Outside the default 30-day window.
    await createIncident({ ownerId: owner.id, bikeId: bike.id, type: 'POSSIBLE_TOWING', category: 'SECURITY', occurredAt: '2026-07-01T08:00:00Z' });
    // Another owner's - must never appear.
    await createIncident({ ownerId: other.id, bikeId: otherBike.id, type: 'POSSIBLE_TOWING', category: 'SECURITY', occurredAt: '2026-09-20T08:00:00Z' });

    const response = await get(owner, '/analytics/incidents-by-type');
    expect(response.statusCode).toBe(200);
    expect(response.json().items).toEqual([
      { type: 'POSSIBLE_POTHOLE', label: 'Possible pothole / speed bump', count: 3 },
      { type: 'POSSIBLE_COLLISION', label: 'Possible collision', count: 1 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// incidents-timeseries
// ---------------------------------------------------------------------------

describe('GET /analytics/incidents-timeseries', () => {
  it('buckets by the owner\'s local day and zero-fills empty days', async () => {
    const owner = await registerUser(ctx, 'OWNER');
    const bike = await createBike(owner.id, 'Scooter 1');

    // 17:30 Colombo on the 19th.
    await createIncident({ ownerId: owner.id, bikeId: bike.id, type: 'POSSIBLE_POTHOLE', category: 'INFO', occurredAt: '2026-09-19T12:00:00Z' });
    // 19:00 UTC on the 20th is 00:30 Colombo on the 21st - it belongs to the 21st.
    await createIncident({ ownerId: owner.id, bikeId: bike.id, type: 'POSSIBLE_COLLISION', category: 'EMERGENCY', occurredAt: '2026-09-20T19:00:00Z' });
    await createIncident({ ownerId: owner.id, bikeId: bike.id, type: 'POSSIBLE_TOWING', category: 'SECURITY', occurredAt: '2026-09-21T02:00:00Z' });

    // From Colombo midnight on the 19th to now.
    const response = await get(
      owner,
      '/analytics/incidents-timeseries?from=2026-09-18T18:30:00Z&to=2026-09-21T06:30:00Z&bucket=day',
    );

    expect(response.statusCode).toBe(200);
    expect(response.json().items).toEqual([
      { date: '2026-09-19', EMERGENCY: 0, SECURITY: 0, INFO: 1 },
      // A quiet day is still a day: without it a line would slope across it.
      { date: '2026-09-20', EMERGENCY: 0, SECURITY: 0, INFO: 0 },
      { date: '2026-09-21', EMERGENCY: 1, SECURITY: 1, INFO: 0 },
    ]);
  });

  it('returns one row per day for the default 30-day window even with no data', async () => {
    const owner = await registerUser(ctx, 'OWNER');
    const response = await get(owner, '/analytics/incidents-timeseries');

    const items = response.json().items as { EMERGENCY: number }[];
    expect(items.length).toBeGreaterThanOrEqual(30);
    expect(items.length).toBeLessThanOrEqual(31);
    expect(items.every((item) => item.EMERGENCY === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// distance-by-bike
// ---------------------------------------------------------------------------

describe('GET /analytics/distance-by-bike', () => {
  it('sums rides that started in range and still lists idle bikes', async () => {
    const owner = await registerUser(ctx, 'OWNER');
    const busy = await createBike(owner.id, 'Scooter 1');
    const idle = await createBike(owner.id, 'Scooter 2');

    await createEndedRental({ ownerId: owner.id, bikeId: busy.id, startedAt: '2026-09-10T08:00:00Z', distanceMeters: 1200 });
    await createEndedRental({ ownerId: owner.id, bikeId: busy.id, startedAt: '2026-09-18T08:00:00Z', distanceMeters: 800 });
    // Started before the window: not counted, so no ride is ever counted twice.
    await createEndedRental({ ownerId: owner.id, bikeId: busy.id, startedAt: '2026-07-01T08:00:00Z', distanceMeters: 9999 });

    const response = await get(owner, '/analytics/distance-by-bike');
    expect(response.json().items).toEqual([
      { bikeId: busy.id, label: 'Scooter 1', distanceM: 2000 },
      { bikeId: idle.id, label: 'Scooter 2', distanceM: 0 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// response-outcomes
// ---------------------------------------------------------------------------

describe('GET /analytics/response-outcomes', () => {
  it('counts EMERGENCY outcomes and takes the median of accepted responses only', async () => {
    const owner = await registerUser(ctx, 'OWNER');
    const bike = await createBike(owner.id, 'Scooter 1');

    const asked = '2026-09-20T08:00:00.000Z';
    const outcome = async (decision: 'SAFE' | 'HELP' | 'TIMEOUT', respondAfterSec: number | null, accepted = true) => {
      const incident = await createIncident({
        ownerId: owner.id,
        bikeId: bike.id,
        type: 'POSSIBLE_COLLISION',
        category: 'EMERGENCY',
        occurredAt: asked,
        questionSentAt: asked,
        decision,
        state: decision === 'SAFE' ? 'RESOLVED_SAFE' : 'ESCALATED',
      });
      if (respondAfterSec !== null) {
        await ctx.prisma.driverResponse.create({
          data: {
            incidentId: incident.id,
            choice: decision === 'HELP' ? 'HELP' : 'SAFE',
            source: 'APP',
            idempotencyKey: randomUUID(),
            serverReceivedAt: new Date(new Date(asked).getTime() + respondAfterSec * 1000),
            accepted,
            rejectReason: accepted ? null : 'TOO_LATE',
          },
        });
      }
    };

    await outcome('SAFE', 10);
    await outcome('SAFE', 40);
    await outcome('HELP', 20);
    // The rider answered at 90 s - too late. It is a TIMEOUT, not a 90 s response.
    await outcome('TIMEOUT', 90, false);

    // Neither of these belongs in the funnel.
    await createIncident({ ownerId: owner.id, bikeId: bike.id, type: 'POSSIBLE_TOWING', category: 'SECURITY', occurredAt: asked });
    await createIncident({ ownerId: owner.id, bikeId: bike.id, type: 'POSSIBLE_COLLISION', category: 'EMERGENCY', occurredAt: asked, decision: 'PENDING', state: 'AWAITING_RESPONSE' });

    const response = await get(owner, '/analytics/response-outcomes');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      SAFE: 2,
      HELP: 1,
      TIMEOUT: 1,
      OFFLINE_FALLBACK: 0,
      // median of 10, 20, 40 - the refused 90 s response is excluded.
      medianResponseSec: 20,
    });
  });

  it('reports a null median rather than 0 when nobody has answered yet', async () => {
    const owner = await registerUser(ctx, 'OWNER');
    const response = await get(owner, '/analytics/response-outcomes');
    expect(response.json().medianResponseSec).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// potholes
// ---------------------------------------------------------------------------

describe('GET /analytics/potholes', () => {
  it('returns positioned potholes with their peak g, and skips ones with no fix', async () => {
    const owner = await registerUser(ctx, 'OWNER');
    const bike = await createBike(owner.id, 'Scooter 1');

    await createIncident({
      ownerId: owner.id,
      bikeId: bike.id,
      type: 'POSSIBLE_POTHOLE',
      category: 'INFO',
      occurredAt: '2026-09-20T08:00:00Z',
      lat: 6.9147,
      lon: 79.9729,
      evidence: { peakAccelerationG: 1.9, durationMs: 180 },
    });
    await createIncident({ ownerId: owner.id, bikeId: bike.id, type: 'POSSIBLE_POTHOLE', category: 'INFO', occurredAt: '2026-09-20T09:00:00Z' });
    await createIncident({ ownerId: owner.id, bikeId: bike.id, type: 'POSSIBLE_TOWING', category: 'SECURITY', occurredAt: '2026-09-20T09:00:00Z', lat: 6.9, lon: 79.9 });

    const response = await get(owner, '/analytics/potholes');
    expect(response.json().items).toEqual([
      { lat: 6.9147, lon: 79.9729, at: '2026-09-20T08:00:00.000Z', peakG: 1.9 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// dashboard
// ---------------------------------------------------------------------------

describe('GET /owners/me/dashboard', () => {
  it('computes KPIs, the open emergency and recent activity for this owner only', async () => {
    const owner = await registerUser(ctx, 'OWNER');
    const other = await registerUser(ctx, 'OWNER');
    const now = ctx.clock.now();

    // One bike reporting right now (ONLINE), one that has never reported.
    const device = await ctx.prisma.device.create({
      data: {
        code: 'CL-0901',
        secretEnc: 'v1:x:x:x',
        pairingCodeHash: 'x',
        config: { telemetryOnSec: 10, telemetryOffSec: 60 } as Prisma.InputJsonValue,
        lastSeenAt: new Date(now.getTime() - 5_000),
      },
    });
    const online = await ctx.prisma.bike.create({
      data: { ownerId: owner.id, label: 'Scooter 1', deviceId: device.id, ignition: 'ON' },
    });
    await createBike(owner.id, 'Scooter 2');

    // Today (Colombo) vs yesterday.
    await createIncident({ ownerId: owner.id, bikeId: online.id, type: 'POSSIBLE_POTHOLE', category: 'INFO', state: 'INFO_RECORDED', occurredAt: '2026-09-21T01:00:00Z' });
    const emergency = await createIncident({ ownerId: owner.id, bikeId: online.id, type: 'POSSIBLE_COLLISION', category: 'EMERGENCY', state: 'ESCALATED', decision: 'TIMEOUT', occurredAt: '2026-09-21T05:00:00Z' });
    await createIncident({ ownerId: owner.id, bikeId: online.id, type: 'POSSIBLE_TOWING', category: 'SECURITY', state: 'OPEN', occurredAt: '2026-09-19T05:00:00Z' });
    // Closed - not "open".
    await createIncident({ ownerId: owner.id, bikeId: online.id, type: 'POSSIBLE_ROLLOVER', category: 'EMERGENCY', state: 'CLOSED', occurredAt: '2026-09-18T05:00:00Z' });

    const otherBike = await createBike(other.id, 'Theirs');
    await createIncident({ ownerId: other.id, bikeId: otherBike.id, type: 'POSSIBLE_COLLISION', category: 'EMERGENCY', state: 'ESCALATED', occurredAt: '2026-09-21T05:30:00Z' });

    const response = await get(owner, '/owners/me/dashboard');
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.kpis).toEqual({
      bikesOnline: 1,
      bikesTotal: 2,
      activeRentals: 0,
      openIncidents: 2,
      incidentsToday: 2,
    });
    // The newest *open* emergency - not the other owner's, not the closed one.
    expect(body.openEmergency.id).toBe(emergency.id);
    expect(body.openEmergency.label).toBe('Possible collision');
    expect(body.bikes).toHaveLength(2);
    expect(body.recent.map((incident: { occurredAt: string }) => incident.occurredAt)).toEqual([
      '2026-09-21T05:00:00.000Z',
      '2026-09-21T01:00:00.000Z',
      '2026-09-19T05:00:00.000Z',
      '2026-09-18T05:00:00.000Z',
    ]);
  });

  it('reports no open emergency once it is acknowledged', async () => {
    const owner = await registerUser(ctx, 'OWNER');
    const bike = await createBike(owner.id, 'Scooter 1');
    await createIncident({ ownerId: owner.id, bikeId: bike.id, type: 'POSSIBLE_COLLISION', category: 'EMERGENCY', state: 'CLOSED', occurredAt: '2026-09-21T05:00:00Z' });

    const response = await get(owner, '/owners/me/dashboard');
    expect(response.json().openEmergency).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// roles
// ---------------------------------------------------------------------------

describe('roles (§5.4.7 table)', () => {
  let demoOwner: TestUser;

  beforeEach(async () => {
    demoOwner = await registerUser(ctx, 'OWNER');
    await ctx.prisma.user.update({ where: { id: demoOwner.id }, data: { isDemo: true } });
    const bike = await createBike(demoOwner.id, 'Scooter 1');
    await createIncident({ ownerId: demoOwner.id, bikeId: bike.id, type: 'POSSIBLE_POTHOLE', category: 'INFO', occurredAt: '2026-09-20T08:00:00Z', lat: 6.9, lon: 79.9 });
  });

  it('lets a GUEST read the demo owner\'s analytics, but not response outcomes', async () => {
    const guest = await createUserDirectly(ctx, 'GUEST', { isDemo: true });

    for (const url of [
      '/owners/me/dashboard',
      '/analytics/incidents-by-type',
      '/analytics/incidents-timeseries',
      '/analytics/distance-by-bike',
      '/analytics/potholes',
    ]) {
      const response = await get(guest, url);
      expect(response.statusCode, url).toBe(200);
    }

    const byType = await get(guest, '/analytics/incidents-by-type');
    expect(byType.json().items).toEqual([
      { type: 'POSSIBLE_POTHOLE', label: 'Possible pothole / speed bump', count: 1 },
    ]);

    // §5.4.7 lists response-outcomes as OWNER only.
    const outcomes = await get(guest, '/analytics/response-outcomes');
    expect(outcomes.statusCode).toBe(403);
    expect(outcomes.json().code).toBe('FORBIDDEN');
  });

  it('refuses a DRIVER every analytics route', async () => {
    const driver = await registerUser(ctx, 'DRIVER');
    for (const url of ['/owners/me/dashboard', '/analytics/incidents-by-type', '/analytics/potholes']) {
      expect((await get(driver, url)).statusCode, url).toBe(403);
    }
  });
});
