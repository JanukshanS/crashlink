/**
 * FR-DEMO-01 seed, FR-DEMO-03 demo reset, and the demo:check rules.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedDemo } from '../src/demo/seedDemo.js';
import { DemoResetRefused, resetDemoData } from '../src/demo/demoReset.js';
import {
  classifyCert,
  classifyCommands,
  classifyDevice,
  classifyWorker,
  summarize,
} from '../src/demo/checkRules.js';
import { createTestContext, destroyTestContext, registerUser, resetDatabase, type TestContext } from './helpers.js';

// ---------------------------------------------------------------------------
// demo:check rules (pure)
// ---------------------------------------------------------------------------

describe('demo:check rules', () => {
  const now = new Date('2026-09-21T06:30:00Z');
  const ago = (sec: number) => new Date(now.getTime() - sec * 1000).toISOString();

  it('judges a worker by how overdue it is against its own interval', () => {
    const deadline = { name: 'deadline', intervalMs: 1000, lastError: null };
    expect(classifyWorker({ ...deadline, lastRunAt: ago(2) }, now).status).toBe('green');
    expect(classifyWorker({ ...deadline, lastRunAt: ago(20) }, now).status).toBe('yellow');
    expect(classifyWorker({ ...deadline, lastRunAt: ago(120) }, now).status).toBe('red');

    // An hour late is nothing for the daily retention worker.
    const retention = { name: 'retention', intervalMs: 86_400_000, lastError: null };
    expect(classifyWorker({ ...retention, lastRunAt: ago(3600) }, now).status).toBe('green');
  });

  it('is red for a worker that never ran or whose last pass failed', () => {
    expect(classifyWorker({ name: 'deadline', intervalMs: 1000, lastError: null, lastRunAt: null }, now).status).toBe('red');
    expect(classifyWorker({ name: 'deadline', intervalMs: 1000, lastError: 'db down', lastRunAt: ago(1) }, now).status).toBe('red');
  });

  it('is red for real hardware offline, yellow for the simulator offline', () => {
    const base = { bikeLabel: 'Scooter 1', lastSeenAt: null, revoked: false };
    expect(classifyDevice({ ...base, code: 'CL-0001', online: 'OFFLINE', simulator: false }, now).status).toBe('red');
    expect(classifyDevice({ ...base, code: 'CL-0002', online: 'OFFLINE', simulator: true }, now).status).toBe('yellow');
    expect(classifyDevice({ ...base, code: 'CL-0001', online: 'ONLINE', simulator: false }, now).status).toBe('green');
    expect(classifyDevice({ ...base, code: 'CL-0001', online: 'ONLINE', simulator: false, revoked: true }, now).status).toBe('red');
  });

  it('flags commands the device is not picking up', () => {
    expect(classifyCommands([]).status).toBe('green');
    expect(classifyCommands([{ deviceCode: 'CL-0001', type: 'SET_ASSIGNMENT', ageSec: 20 }]).status).toBe('yellow');
    const stuck = classifyCommands([{ deviceCode: 'CL-0001', type: 'SET_ASSIGNMENT', ageSec: 900 }]);
    expect(stuck.status).toBe('red');
    expect(stuck.detail).toContain('CL-0001 SET_ASSIGNMENT');
  });

  it('grades certificate expiry, and skips a non-https base URL rather than passing it', () => {
    const inDays = (days: number) => new Date(now.getTime() + days * 86_400_000);
    expect(classifyCert({ kind: 'ok', host: 'h', validTo: inDays(60) }, now).status).toBe('green');
    expect(classifyCert({ kind: 'ok', host: 'h', validTo: inDays(7) }, now).status).toBe('yellow');
    expect(classifyCert({ kind: 'ok', host: 'h', validTo: inDays(1) }, now).status).toBe('red');
    expect(classifyCert({ kind: 'ok', host: 'h', validTo: inDays(-1) }, now).status).toBe('red');
    expect(classifyCert({ kind: 'error', host: 'h', message: 'refused' }, now).status).toBe('red');
    expect(classifyCert({ kind: 'not-https', url: 'http://x' }, now).status).toBe('yellow');
  });

  it('is ready only when nothing is red', () => {
    expect(summarize([{ name: 'a', status: 'green', detail: '' }, { name: 'b', status: 'yellow', detail: '' }]).ready).toBe(true);
    expect(summarize([{ name: 'a', status: 'green', detail: '' }, { name: 'b', status: 'red', detail: '' }]).ready).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Seed and reset against the database
// ---------------------------------------------------------------------------

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await destroyTestContext(ctx);
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
});

describe('FR-DEMO-01 seed', () => {
  it('creates the admin, Nimal, Ravi, the contact, the judge and Scooter 1 paired to CL-0001', async () => {
    const result = await seedDemo(ctx.prisma, ctx.config, { writeSecretsHeader: false });

    const users = await ctx.prisma.user.findMany({ select: { email: true, role: true, name: true } });
    expect(users).toEqual(
      expect.arrayContaining([
        { email: 'admin@crashlink.lk', role: 'ADMIN', name: 'CrashLink Admin' },
        { email: 'owner@demo.lk', role: 'OWNER', name: 'Nimal Perera' },
        { email: 'ravi@demo.lk', role: 'DRIVER', name: 'Ravi Kumar' },
        { email: 'judge@demo.lk', role: 'GUEST', name: 'Judge (read-only)' },
      ]),
    );

    const contact = await ctx.prisma.emergencyContact.findFirstOrThrow({ where: { isCurrent: true } });
    expect(contact).toMatchObject({ name: 'Kamala', relationship: 'Mother' });

    const scooter = await ctx.prisma.bike.findFirstOrThrow({ where: { label: 'Scooter 1' }, include: { device: true } });
    expect(scooter.device?.code).toBe('CL-0001');

    // New devices come with credentials, exactly once.
    expect(result.devices.every((device) => device.credentials !== null)).toBe(true);
    expect(result.incidents).toBeGreaterThan(0);
  });

  it('keeps device secrets on a re-seed, so the real bike is not locked out', async () => {
    await seedDemo(ctx.prisma, ctx.config, { writeSecretsHeader: false });
    const before = await ctx.prisma.device.findUniqueOrThrow({ where: { code: 'CL-0001' } });

    const again = await seedDemo(ctx.prisma, ctx.config, { writeSecretsHeader: false });
    const after = await ctx.prisma.device.findUniqueOrThrow({ where: { code: 'CL-0001' } });

    expect(after.secretEnc).toBe(before.secretEnc);
    expect(after.pairingCodeHash).toBe(before.pairingCodeHash);
    expect(again.devices.every((device) => device.credentials === null)).toBe(true);
    // Idempotent: one current contact, not one per run.
    expect(await ctx.prisma.emergencyContact.count({ where: { isCurrent: true } })).toBe(1);

    const rotated = await seedDemo(ctx.prisma, ctx.config, { rotateDeviceSecrets: true, writeSecretsHeader: false });
    const afterRotate = await ctx.prisma.device.findUniqueOrThrow({ where: { code: 'CL-0001' } });
    expect(afterRotate.secretEnc).not.toBe(before.secretEnc);
    expect(rotated.devices[0]?.credentials).not.toBeNull();
  });
});

describe('FR-DEMO-03 demo reset', () => {
  it('clears demo incidents and rentals, re-seeds, and never touches a real owner\'s data', async () => {
    await seedDemo(ctx.prisma, ctx.config, { writeSecretsHeader: false });
    const scooter = await ctx.prisma.bike.findFirstOrThrow({ where: { label: 'Scooter 1' } });
    const nimal = await ctx.prisma.user.findUniqueOrThrow({ where: { email: 'owner@demo.lk' } });
    const secretBefore = (await ctx.prisma.device.findUniqueOrThrow({ where: { code: 'CL-0001' } })).secretEnc;

    // A rehearsal incident left open on the demo bike...
    const rehearsal = await ctx.prisma.incident.create({
      data: {
        id: randomUUID(),
        bikeId: scooter.id,
        ownerId: nimal.id,
        type: 'POSSIBLE_COLLISION',
        category: 'EMERGENCY',
        state: 'ESCALATED',
        decision: 'TIMEOUT',
        occurredAt: new Date(),
        timeSource: 'GPS',
        locationKind: 'UNAVAILABLE',
        evidence: {},
        isDemo: true,
      },
    });

    // ...and a real owner's incident, which must survive.
    const real = await registerUser(ctx, 'OWNER');
    const realBike = await ctx.prisma.bike.create({ data: { ownerId: real.id, label: 'Real bike' } });
    const realIncident = await ctx.prisma.incident.create({
      data: {
        id: randomUUID(),
        bikeId: realBike.id,
        ownerId: real.id,
        type: 'POSSIBLE_TOWING',
        category: 'SECURITY',
        state: 'OPEN',
        occurredAt: new Date(),
        timeSource: 'GPS',
        locationKind: 'UNAVAILABLE',
        evidence: {},
        isDemo: false,
      },
    });

    const result = await resetDemoData(ctx.prisma, ctx.config, ctx.clock);

    expect(result.incidents).toBeGreaterThan(0);
    expect(await ctx.prisma.incident.findUnique({ where: { id: rehearsal.id } })).toBeNull();
    expect(await ctx.prisma.incident.findUnique({ where: { id: realIncident.id } })).not.toBeNull();
    expect(await ctx.prisma.bike.findUnique({ where: { id: realBike.id } })).not.toBeNull();

    // Baseline demo history is back, with no open rehearsal state.
    expect(await ctx.prisma.incident.count({ where: { ownerId: nimal.id } })).toBe(result.seed.incidents);
    expect(
      await ctx.prisma.incident.count({ where: { ownerId: nimal.id, state: { in: ['OPEN', 'AWAITING_RESPONSE', 'ESCALATED'] } } }),
    ).toBe(0);

    // The bikes keep working: device secrets were not rotated.
    expect((await ctx.prisma.device.findUniqueOrThrow({ where: { code: 'CL-0001' } })).secretEnc).toBe(secretBefore);

    // §5.7.3: demo reset is audited.
    expect(await ctx.prisma.auditEvent.count({ where: { action: 'DEMO_RESET' } })).toBe(1);
  });

  it('refuses to run when DEMO_MODE is off, unless forced', async () => {
    const production = { ...ctx.config, DEMO_MODE: false };
    await expect(resetDemoData(ctx.prisma, production, ctx.clock)).rejects.toBeInstanceOf(DemoResetRefused);
    await expect(resetDemoData(ctx.prisma, production, ctx.clock, { force: true })).resolves.toBeDefined();
  });
});
