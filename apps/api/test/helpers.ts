/**
 * Shared test harness: one app + one Prisma client per file, a fake clock, and
 * fixture builders for the roles the §5.7.2 matrix cares about.
 */
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_DEVICE_CONFIG } from '@crashlink/contracts';
import { buildApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { FakeClock } from '../src/lib/time.js';
import { RecordingEmitter } from '../src/lib/realtime.js';
import { encryptSecret, generatePairingCode } from '../src/lib/crypto.js';

export interface TestContext {
  app: FastifyInstance;
  prisma: PrismaClient;
  clock: FakeClock;
  config: Config;
  /** §5.5 events the app would have pushed; asserted on directly. */
  realtime: RecordingEmitter;
}

export const createTestContext = async (
  overrides: { imageDir?: string } = {},
): Promise<TestContext> => {
  const prisma = new PrismaClient();
  const clock = new FakeClock('2026-09-21T06:30:00.000Z');
  const realtime = new RecordingEmitter();

  const base = loadConfig();
  const config: Config = overrides.imageDir ? { ...base, IMAGE_DIR: overrides.imageDir } : base;

  // Sockets and worker intervals are off: tests step the clock and call
  // `workers.runOnce()` so nothing depends on wall-clock timing.
  const app = await buildApp({ config, clock, prisma, realtime });

  return { app, prisma, clock, config, realtime };
};

export const destroyTestContext = async (ctx: TestContext): Promise<void> => {
  await ctx.app.close();
  await ctx.prisma.$disconnect();
};

/**
 * Wipes every table between tests. TRUNCATE ... CASCADE is used rather than
 * per-model deletes so the order of the foreign keys cannot make this flaky.
 */
export const resetDatabase = async (prisma: PrismaClient): Promise<void> => {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      notification_attempts, notifications, driver_responses, incident_images, incidents,
      location_samples, ignition_events, rentals, bikes, device_commands, device_nonces,
      devices, emergency_contacts, push_tokens, refresh_tokens, password_resets,
      user_settings, idempotency_records, audit_events, share_links, users
    RESTART IDENTITY CASCADE
  `);
};

let emailCounter = 0;
const uniqueEmail = (prefix: string): string => {
  emailCounter += 1;
  return `${prefix}-${emailCounter}-${randomUUID().slice(0, 8)}@test.lk`;
};

let phoneCounter = 0;
const uniquePhone = (): string => {
  phoneCounter += 1;
  return `+9477${String(1_000_000 + phoneCounter).slice(-7)}`;
};

export const TEST_PASSWORD = 'password123';

export interface TestUser {
  id: string;
  email: string;
  phone: string;
  name: string;
  accessToken: string;
  refreshToken: string;
}

/** Registers through the real API so the token is exactly what a client gets. */
export const registerUser = async (
  ctx: TestContext,
  role: 'OWNER' | 'DRIVER',
  overrides: { name?: string; email?: string; phone?: string } = {},
): Promise<TestUser> => {
  const email = overrides.email ?? uniqueEmail(role.toLowerCase());
  const phone = overrides.phone ?? uniquePhone();
  const name = overrides.name ?? (role === 'OWNER' ? 'Test Owner' : 'Test Driver');

  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { role, name, email, phone, password: TEST_PASSWORD, consentAccepted: true },
  });

  if (response.statusCode !== 201) {
    throw new Error(`registerUser failed: ${response.statusCode} ${response.body}`);
  }

  const body = response.json();
  return {
    id: body.user.id,
    email,
    phone,
    name,
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
  };
};

/** Seeds a role the API cannot self-register (ADMIN, GUEST). */
export const createUserDirectly = async (
  ctx: TestContext,
  role: 'ADMIN' | 'GUEST' | 'OWNER' | 'DRIVER',
  overrides: { email?: string; phone?: string | null; isDemo?: boolean; name?: string } = {},
): Promise<{ id: string; email: string; accessToken: string }> => {
  const email = overrides.email ?? uniqueEmail(role.toLowerCase());

  const user = await ctx.prisma.user.create({
    data: {
      role,
      name: overrides.name ?? `Test ${role}`,
      email,
      phoneE164: overrides.phone === null ? null : (overrides.phone ?? uniquePhone()),
      passwordHash: await bcrypt.hash(TEST_PASSWORD, 10),
      isDemo: overrides.isDemo ?? false,
      settings: { create: {} },
    },
  });

  const accessToken = ctx.app.jwt.sign({ sub: user.id, role: user.role, isDemo: user.isDemo });
  return { id: user.id, email, accessToken };
};

export const auth = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

/** FR-DRV-01: the current emergency contact a rental will snapshot. */
export const setEmergencyContact = async (
  ctx: TestContext,
  driver: TestUser,
  contact: { name: string; phone: string; relationship: string },
): Promise<{ statusCode: number; body: Record<string, unknown> }> => {
  const response = await ctx.app.inject({
    method: 'PUT',
    url: '/api/v1/drivers/me/emergency-contact',
    headers: auth(driver.accessToken),
    payload: contact,
  });
  return { statusCode: response.statusCode, body: response.json() };
};

/** A provisioned, paired device - the precondition for assigning a rental. */
export const createPairedBike = async (
  ctx: TestContext,
  owner: TestUser,
  label = 'Scooter 1',
): Promise<{ bikeId: string; deviceId: string; deviceCode: string; pairingCode: string }> => {
  const deviceCode = `CL-${String(Math.floor(Math.random() * 9000) + 1000)}`;
  const pairingCode = generatePairingCode();

  const device = await ctx.prisma.device.create({
    data: {
      code: deviceCode,
      secretEnc: encryptSecret('a'.repeat(64), ctx.config.DEVICE_SECRET_KEY),
      pairingCodeHash: await bcrypt.hash(pairingCode, 10),
      config: DEFAULT_DEVICE_CONFIG as unknown as object,
    },
  });

  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/bikes',
    headers: auth(owner.accessToken),
    payload: { label },
  });
  const bikeId = created.json().id as string;

  const paired = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/bikes/${bikeId}/pair`,
    headers: auth(owner.accessToken),
    payload: { deviceCode, pairingCode },
  });
  if (paired.statusCode !== 200) {
    throw new Error(`createPairedBike failed to pair: ${paired.statusCode} ${paired.body}`);
  }

  return { bikeId, deviceId: device.id, deviceCode, pairingCode };
};

/**
 * Pairs an already-provisioned device (from `createDevice`) to a new bike, so a
 * test can hold the device secret and sign `/d/v1` requests for that bike.
 */
export const pairDeviceToBike = async (
  ctx: TestContext,
  owner: TestUser,
  device: { code: string; pairingCode: string },
  label = 'Scooter 1',
): Promise<string> => {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/bikes',
    headers: auth(owner.accessToken),
    payload: { label },
  });
  const bikeId = created.json().id as string;

  const paired = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/bikes/${bikeId}/pair`,
    headers: auth(owner.accessToken),
    payload: { deviceCode: device.code, pairingCode: device.pairingCode },
  });
  if (paired.statusCode !== 200) {
    throw new Error(`pairDeviceToBike failed: ${paired.statusCode} ${paired.body}`);
  }

  return bikeId;
};

/** A driver who already has a current emergency contact, ready to be assigned. */
export const createReadyDriver = async (ctx: TestContext, name = 'Ravi Kumar'): Promise<TestUser> => {
  const driver = await registerUser(ctx, 'DRIVER', { name });
  await setEmergencyContact(ctx, driver, {
    name: 'Kamala',
    phone: uniquePhone(),
    relationship: 'Mother',
  });
  return driver;
};

export const assignRental = async (
  ctx: TestContext,
  owner: TestUser,
  bikeId: string,
  driverId: string,
): Promise<{ statusCode: number; body: Record<string, unknown> }> => {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/rentals',
    headers: auth(owner.accessToken),
    payload: { bikeId, driverId, idempotencyKey: randomUUID() },
  });
  return { statusCode: response.statusCode, body: response.json() };
};
