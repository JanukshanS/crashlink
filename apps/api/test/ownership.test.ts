/**
 * §5.7.2 authorization: every owner/driver query is ownership-scoped, another
 * owner's id returns **404** rather than 403 (so the API cannot be used to
 * enumerate ids), and the GUEST account is read-only.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assignRental,
  auth,
  createPairedBike,
  createReadyDriver,
  createTestContext,
  createUserDirectly,
  destroyTestContext,
  registerUser,
  resetDatabase,
  type TestContext,
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
});

describe('Cross-owner access returns 404 (§5.7.2)', () => {
  it('hides another owner bike from read, update, pairing and unpairing', async () => {
    const ownerA = await registerUser(ctx, 'OWNER', { name: 'Owner A' });
    const ownerB = await registerUser(ctx, 'OWNER', { name: 'Owner B' });
    const { bikeId } = await createPairedBike(ctx, ownerA, 'A bike');

    const cases = [
      { method: 'GET' as const, url: `/api/v1/bikes/${bikeId}` },
      { method: 'PATCH' as const, url: `/api/v1/bikes/${bikeId}`, payload: { label: 'stolen' } },
      {
        method: 'POST' as const,
        url: `/api/v1/bikes/${bikeId}/pair`,
        payload: { deviceCode: 'CL-9999', pairingCode: 'ABCD1234' },
      },
      { method: 'DELETE' as const, url: `/api/v1/bikes/${bikeId}/pair` },
    ];

    for (const testCase of cases) {
      const response = await ctx.app.inject({
        method: testCase.method,
        url: testCase.url,
        headers: auth(ownerB.accessToken),
        ...(testCase.payload ? { payload: testCase.payload } : {}),
      });

      // 404, never 403: owner B must not learn that this id exists.
      expect(response.statusCode, `${testCase.method} ${testCase.url}`).toBe(404);
      expect(response.json().code).toBe('NOT_FOUND');
    }

    // Owner A's bike is untouched.
    const bike = await ctx.prisma.bike.findUniqueOrThrow({ where: { id: bikeId } });
    expect(bike.label).toBe('A bike');
    expect(bike.deviceId).not.toBeNull();
  });

  it('keeps the bike list scoped to the caller', async () => {
    const ownerA = await registerUser(ctx, 'OWNER');
    const ownerB = await registerUser(ctx, 'OWNER');
    await createPairedBike(ctx, ownerA, 'A bike');
    await createPairedBike(ctx, ownerB, 'B bike');

    const listA = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/bikes',
      headers: auth(ownerA.accessToken),
    });

    const items = listA.json().items as { label: string }[];
    expect(items).toHaveLength(1);
    expect(items[0]?.label).toBe('A bike');
  });

  it('hides another owner rental from read, cancel, end and force-activate', async () => {
    const ownerA = await registerUser(ctx, 'OWNER');
    const ownerB = await registerUser(ctx, 'OWNER');
    const driver = await createReadyDriver(ctx);
    const { bikeId } = await createPairedBike(ctx, ownerA);

    const { body } = await assignRental(ctx, ownerA, bikeId, driver.id);
    const rentalId = body.id as string;

    const cases = [
      { method: 'GET' as const, url: `/api/v1/rentals/${rentalId}` },
      { method: 'POST' as const, url: `/api/v1/rentals/${rentalId}/cancel` },
      {
        method: 'POST' as const,
        url: `/api/v1/rentals/${rentalId}/end`,
        payload: { idempotencyKey: randomUUID() },
      },
      {
        method: 'POST' as const,
        url: `/api/v1/rentals/${rentalId}/force-activate`,
        payload: { confirm: true },
      },
    ];

    for (const testCase of cases) {
      const response = await ctx.app.inject({
        method: testCase.method,
        url: testCase.url,
        headers: auth(ownerB.accessToken),
        ...(testCase.payload ? { payload: testCase.payload } : {}),
      });
      expect(response.statusCode, `${testCase.method} ${testCase.url}`).toBe(404);
    }

    const rental = await ctx.prisma.rental.findUniqueOrThrow({ where: { id: rentalId } });
    expect(rental.state).toBe('PENDING_SYNC');
  });

  it('lets a driver read their own rental but hides another driver rental', async () => {
    const owner = await registerUser(ctx, 'OWNER');
    const driverA = await createReadyDriver(ctx, 'Driver A');
    const driverB = await createReadyDriver(ctx, 'Driver B');
    const { bikeId } = await createPairedBike(ctx, owner);

    const { body } = await assignRental(ctx, owner, bikeId, driverA.id);
    const rentalId = body.id as string;

    const own = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/rentals/${rentalId}`,
      headers: auth(driverA.accessToken),
    });
    expect(own.statusCode).toBe(200);
    // §5.7.3: a driver sees masked numbers, even on their own rental.
    expect(String(own.json().snapshot.contactPhone)).toMatch(/•/);
    expect(String(own.json().snapshot.ownerPhone)).toMatch(/•/);

    const other = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/rentals/${rentalId}`,
      headers: auth(driverB.accessToken),
    });
    expect(other.statusCode).toBe(404);
  });

  it('returns 404 for an id that does not exist at all', async () => {
    const owner = await registerUser(ctx, 'OWNER');

    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/bikes/${randomUUID()}`,
      headers: auth(owner.accessToken),
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('Role boundaries (§5.7.2)', () => {
  it('refuses a driver access to owner-only routes', async () => {
    const driver = await createReadyDriver(ctx);

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/bikes',
      headers: auth(driver.accessToken),
      payload: { label: 'Not mine' },
    });
    expect(created.statusCode).toBe(403);
    expect(created.json().code).toBe('FORBIDDEN');

    const lookup = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/drivers/lookup?q=someone@demo.lk',
      headers: auth(driver.accessToken),
    });
    expect(lookup.statusCode).toBe(403);
  });

  it('refuses an owner access to driver-only and admin-only routes', async () => {
    const owner = await registerUser(ctx, 'OWNER');

    const contact = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/drivers/me/emergency-contact',
      headers: auth(owner.accessToken),
    });
    expect(contact.statusCode).toBe(403);

    const devices = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/devices',
      headers: auth(owner.accessToken),
      payload: {},
    });
    expect(devices.statusCode).toBe(403);
  });

  it('lets an owner look a driver up by exact email or phone, and 404s otherwise', async () => {
    const owner = await registerUser(ctx, 'OWNER');
    const driver = await createReadyDriver(ctx, 'Ravi Kumar');

    const byEmail = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/drivers/lookup?q=${encodeURIComponent(driver.email)}`,
      headers: auth(owner.accessToken),
    });
    expect(byEmail.statusCode).toBe(200);
    expect(byEmail.json()).toMatchObject({ id: driver.id, name: 'Ravi Kumar', hasEmergencyContact: true, busy: false });
    // §5.7.3: the lookup never hands over a full number.
    expect(String(byEmail.json().phoneMasked)).toMatch(/^\+94•••••\d{4}$/);

    const partial = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/drivers/lookup?q=${encodeURIComponent(driver.email.slice(0, 6))}`,
      headers: auth(owner.accessToken),
    });
    expect(partial.statusCode).toBe(404);
  });
});

describe('GUEST is read-only (§5.4.2, §5.7.2)', () => {
  it('can read the demo owner fleet but is refused every mutation', async () => {
    const demoOwner = await registerUser(ctx, 'OWNER', { name: 'Nimal Perera' });
    await ctx.prisma.user.update({ where: { id: demoOwner.id }, data: { isDemo: true } });
    await createPairedBike(ctx, demoOwner, 'Scooter 1');

    const guest = await createUserDirectly(ctx, 'GUEST', { isDemo: true });

    const bikes = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/bikes',
      headers: auth(guest.accessToken),
    });
    expect(bikes.statusCode).toBe(200);
    expect((bikes.json().items as unknown[]).length).toBe(1);

    // The global guard rejects any non-GET before the route even runs.
    const mutation = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/bikes',
      headers: auth(guest.accessToken),
      payload: { label: 'Guest bike' },
    });
    expect(mutation.statusCode).toBe(403);
    expect(mutation.json().code).toBe('READ_ONLY_GUEST');

    const settings = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/me/settings',
      headers: auth(guest.accessToken),
      payload: { notifySecurity: true, notifyInfo: true, alarmSound: true, theme: 'dark' },
    });
    expect(settings.statusCode).toBe(403);
    expect(settings.json().code).toBe('READ_ONLY_GUEST');
  });
});

describe('Admin device provisioning (FR-DEV-01, §5.4.8)', () => {
  it('returns the secret once and stores it encrypted, not in the clear', async () => {
    const admin = await createUserDirectly(ctx, 'ADMIN');

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/devices',
      headers: auth(admin.accessToken),
      payload: { code: 'CL-0042' },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.code).toBe('CL-0042');
    expect(String(body.secret)).toMatch(/^[0-9a-f]{64}$/);
    expect(String(body.pairingCode)).toMatch(/^[A-Z0-9]{8}$/);

    const device = await ctx.prisma.device.findUniqueOrThrow({ where: { code: 'CL-0042' } });
    // §5.7.1: encrypted (recoverable for HMAC), never the raw secret on disk.
    expect(device.secretEnc).not.toContain(body.secret);
    expect(device.secretEnc.startsWith('v1:')).toBe(true);
    // The pairing code is hashed - the server only ever checks one.
    expect(device.pairingCodeHash).not.toContain(body.pairingCode);

    // The listing never exposes either.
    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/admin/devices',
      headers: auth(admin.accessToken),
    });
    expect(list.body).not.toContain(body.secret);
    expect(list.body).not.toContain(body.pairingCode);
  });

  it('allocates the next free code when none is given, and refuses a duplicate', async () => {
    const admin = await createUserDirectly(ctx, 'ADMIN');

    const first = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/devices',
      headers: auth(admin.accessToken),
      payload: {},
    });
    expect(first.json().code).toBe('CL-0001');

    const second = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/devices',
      headers: auth(admin.accessToken),
      payload: {},
    });
    expect(second.json().code).toBe('CL-0002');

    const duplicate = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/admin/devices',
      headers: auth(admin.accessToken),
      payload: { code: 'CL-0001' },
    });
    expect(duplicate.statusCode).toBe(409);
  });

  it('pairs a bike with the provisioned codes and rejects a wrong pairing code', async () => {
    const admin = await createUserDirectly(ctx, 'ADMIN');
    const owner = await registerUser(ctx, 'OWNER');

    const provisioned = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/admin/devices',
        headers: auth(admin.accessToken),
        payload: { code: 'CL-0077' },
      })
    ).json();

    const bikeId = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/bikes',
        headers: auth(owner.accessToken),
        payload: { label: 'Scooter 1' },
      })
    ).json().id as string;

    const wrong = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/bikes/${bikeId}/pair`,
      headers: auth(owner.accessToken),
      payload: { deviceCode: 'CL-0077', pairingCode: 'AAAA1111' },
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().code).toBe('VALIDATION_FAILED');

    const right = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/bikes/${bikeId}/pair`,
      headers: auth(owner.accessToken),
      payload: { deviceCode: 'CL-0077', pairingCode: provisioned.pairingCode },
    });
    expect(right.statusCode).toBe(200);
    expect(right.json().device).toMatchObject({ code: 'CL-0077', online: 'OFFLINE' });
  });

  it('refuses to pair a device that already belongs to another bike', async () => {
    const ownerA = await registerUser(ctx, 'OWNER');
    const ownerB = await registerUser(ctx, 'OWNER');
    const { deviceCode, pairingCode } = await createPairedBike(ctx, ownerA);

    const bikeB = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/bikes',
        headers: auth(ownerB.accessToken),
        payload: { label: 'B bike' },
      })
    ).json().id as string;

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/bikes/${bikeB}/pair`,
      headers: auth(ownerB.accessToken),
      payload: { deviceCode, pairingCode },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('DEVICE_ALREADY_PAIRED');
  });
});
