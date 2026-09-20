/**
 * FR-RENT-01..03 - the rental invariants and snapshots (§5.4.5, §5.6.3, §5.6.4).
 *
 * The concurrency cases here are the reason the partial unique indexes exist:
 * the service's own pre-checks would happily let two simultaneous assignments
 * through, and only the database stops the second one.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assignRental,
  auth,
  createPairedBike,
  createReadyDriver,
  createTestContext,
  destroyTestContext,
  registerUser,
  resetDatabase,
  setEmergencyContact,
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

describe('POST /rentals - assignment preconditions (FR-RENT-01)', () => {
  it('assigns a driver, snapshots the recipients and queues SET_ASSIGNMENT', async () => {
    const owner = await registerUser(ctx, 'OWNER', { name: 'Nimal Perera' });
    const driver = await createReadyDriver(ctx, 'Ravi Kumar');
    const { bikeId, deviceId } = await createPairedBike(ctx, owner);

    const { statusCode, body } = await assignRental(ctx, owner, bikeId, driver.id);

    expect(statusCode).toBe(201);
    // FR-RENT-03: a rental is PENDING_SYNC until the device acks.
    expect(body.state).toBe('PENDING_SYNC');
    expect(body.assignmentVersion).toBe(1);
    expect(body.snapshot).toMatchObject({ driverName: 'Ravi Kumar', contactName: 'Kamala' });
    // §5.7.3: the contact number is masked in this response.
    expect(String((body.snapshot as Record<string, string>).contactPhoneMasked)).toMatch(/^\+94•••••\d{4}$/);

    const rental = await ctx.prisma.rental.findUniqueOrThrow({ where: { id: body.id as string } });
    expect(rental.ownerPhoneSnapshot).toBe(owner.phone);
    expect(rental.driverNameSnapshot).toBe('Ravi Kumar');
    expect(rental.driverPhoneSnapshot).toBe(driver.phone);
    expect(rental.contactNameSnapshot).toBe('Kamala');

    // §5.3.4: the bike is told who to text, and only then can it ack.
    const command = await ctx.prisma.deviceCommand.findFirstOrThrow({
      where: { deviceId, type: 'SET_ASSIGNMENT' },
    });
    expect(command.status).toBe('QUEUED');
    expect(command.payload).toMatchObject({
      rentalId: rental.id,
      assignmentVersion: 1,
      contactName: 'Kamala',
      ownerPhone: owner.phone,
    });

    const bike = await ctx.prisma.bike.findUniqueOrThrow({ where: { id: bikeId } });
    expect(bike.status).toBe('RENTED');
  });

  it('refuses a driver with no emergency contact (NO_EMERGENCY_CONTACT)', async () => {
    const owner = await registerUser(ctx, 'OWNER');
    const driver = await registerUser(ctx, 'DRIVER');
    const { bikeId } = await createPairedBike(ctx, owner);

    const { statusCode, body } = await assignRental(ctx, owner, bikeId, driver.id);

    expect(statusCode).toBe(409);
    expect(body.code).toBe('NO_EMERGENCY_CONTACT');

    // Nothing was created, and the bike was not marked RENTED.
    expect(await ctx.prisma.rental.count()).toBe(0);
    expect(await ctx.prisma.deviceCommand.count()).toBe(0);
    const bike = await ctx.prisma.bike.findUniqueOrThrow({ where: { id: bikeId } });
    expect(bike.status).toBe('AVAILABLE');
  });

  it('accepts the same driver once the contact is set', async () => {
    const owner = await registerUser(ctx, 'OWNER');
    const driver = await registerUser(ctx, 'DRIVER');
    const { bikeId } = await createPairedBike(ctx, owner);

    const refused = await assignRental(ctx, owner, bikeId, driver.id);
    expect(refused.statusCode).toBe(409);

    await setEmergencyContact(ctx, driver, {
      name: 'Kamala',
      phone: '+94712223344',
      relationship: 'Mother',
    });

    const accepted = await assignRental(ctx, owner, bikeId, driver.id);
    expect(accepted.statusCode).toBe(201);
  });

  it('refuses a bike with no paired device (DEVICE_NOT_PAIRED)', async () => {
    const owner = await registerUser(ctx, 'OWNER');
    const driver = await createReadyDriver(ctx);

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/bikes',
      headers: auth(owner.accessToken),
      payload: { label: 'Unpaired bike' },
    });
    const bikeId = created.json().id as string;

    const { statusCode, body } = await assignRental(ctx, owner, bikeId, driver.id);
    expect(statusCode).toBe(409);
    expect(body.code).toBe('DEVICE_NOT_PAIRED');
  });

  it('replays the stored result for a repeated idempotency key', async () => {
    const owner = await registerUser(ctx, 'OWNER');
    const driver = await createReadyDriver(ctx);
    const { bikeId } = await createPairedBike(ctx, owner);

    const idempotencyKey = randomUUID();
    const payload = { bikeId, driverId: driver.id, idempotencyKey };

    const first = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/rentals',
      headers: auth(owner.accessToken),
      payload,
    });
    const second = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/rentals',
      headers: auth(owner.accessToken),
      payload,
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json().id).toBe(first.json().id);
    expect(await ctx.prisma.rental.count()).toBe(1);
  });
});

describe('FR-RENT-02 - one open rental per bike (DB-enforced)', () => {
  it('rejects a second rental on the same bike with RENTAL_ACTIVE_EXISTS', async () => {
    const owner = await registerUser(ctx, 'OWNER');
    const driverA = await createReadyDriver(ctx, 'Driver A');
    const driverB = await createReadyDriver(ctx, 'Driver B');
    const { bikeId } = await createPairedBike(ctx, owner);

    expect((await assignRental(ctx, owner, bikeId, driverA.id)).statusCode).toBe(201);

    const second = await assignRental(ctx, owner, bikeId, driverB.id);
    expect(second.statusCode).toBe(409);
    expect(second.body.code).toBe('RENTAL_ACTIVE_EXISTS');
  });

  it('holds under concurrent requests - exactly one rental survives', async () => {
    const owner = await registerUser(ctx, 'OWNER');
    const { bikeId } = await createPairedBike(ctx, owner);

    const drivers = await Promise.all([
      createReadyDriver(ctx, 'Driver 1'),
      createReadyDriver(ctx, 'Driver 2'),
      createReadyDriver(ctx, 'Driver 3'),
      createReadyDriver(ctx, 'Driver 4'),
    ]);

    // Fired together: the service pre-checks all pass, so the partial unique
    // index `rentals_one_open_per_bike` is what has to hold the line.
    const responses = await Promise.all(
      drivers.map((driver) =>
        ctx.app.inject({
          method: 'POST',
          url: '/api/v1/rentals',
          headers: auth(owner.accessToken),
          payload: { bikeId, driverId: driver.id, idempotencyKey: randomUUID() },
        }),
      ),
    );

    const created = responses.filter((response) => response.statusCode === 201);
    const rejected = responses.filter((response) => response.statusCode !== 201);

    expect(created).toHaveLength(1);
    expect(rejected).toHaveLength(3);
    for (const response of rejected) {
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe('RENTAL_ACTIVE_EXISTS');
    }

    const openRentals = await ctx.prisma.rental.count({
      where: { bikeId, state: { in: ['PENDING_SYNC', 'ACTIVE', 'ENDING_SYNC'] } },
    });
    expect(openRentals).toBe(1);
  });

  it('is enforced by the database even when the service layer is bypassed', async () => {
    const owner = await registerUser(ctx, 'OWNER');
    const driverA = await createReadyDriver(ctx, 'Driver A');
    const driverB = await createReadyDriver(ctx, 'Driver B');
    const { bikeId } = await createPairedBike(ctx, owner);

    await assignRental(ctx, owner, bikeId, driverA.id);

    const contactB = await ctx.prisma.emergencyContact.findFirstOrThrow({
      where: { driverId: driverB.id, isCurrent: true },
    });

    // A direct insert, exactly what a future code path might get wrong.
    await expect(
      ctx.prisma.rental.create({
        data: {
          bikeId,
          driverId: driverB.id,
          ownerId: owner.id,
          emergencyContactId: contactB.id,
          ownerPhoneSnapshot: owner.phone,
          driverNameSnapshot: 'Driver B',
          contactNameSnapshot: contactB.name,
          contactPhoneSnapshot: contactB.phoneE164,
          state: 'ACTIVE',
          assignmentVersion: 99,
        },
      }),
    ).rejects.toThrow();
  });
});

describe('FR-RENT-02 - one open rental per driver (DB-enforced)', () => {
  it('rejects a second rental for the same driver with DRIVER_BUSY', async () => {
    const owner = await registerUser(ctx, 'OWNER');
    const driver = await createReadyDriver(ctx);
    const first = await createPairedBike(ctx, owner, 'Scooter 1');
    const second = await createPairedBike(ctx, owner, 'Scooter 2');

    expect((await assignRental(ctx, owner, first.bikeId, driver.id)).statusCode).toBe(201);

    const clash = await assignRental(ctx, owner, second.bikeId, driver.id);
    expect(clash.statusCode).toBe(409);
    expect(clash.body.code).toBe('DRIVER_BUSY');
  });

  it('holds under concurrent requests across different bikes', async () => {
    const owner = await registerUser(ctx, 'OWNER');
    const driver = await createReadyDriver(ctx);

    const bikes = await Promise.all([
      createPairedBike(ctx, owner, 'Scooter 1'),
      createPairedBike(ctx, owner, 'Scooter 2'),
      createPairedBike(ctx, owner, 'Scooter 3'),
      createPairedBike(ctx, owner, 'Scooter 4'),
    ]);

    const responses = await Promise.all(
      bikes.map((bike) =>
        ctx.app.inject({
          method: 'POST',
          url: '/api/v1/rentals',
          headers: auth(owner.accessToken),
          payload: { bikeId: bike.bikeId, driverId: driver.id, idempotencyKey: randomUUID() },
        }),
      ),
    );

    const created = responses.filter((response) => response.statusCode === 201);
    expect(created).toHaveLength(1);

    for (const response of responses.filter((r) => r.statusCode !== 201)) {
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe('DRIVER_BUSY');
    }

    const openRentals = await ctx.prisma.rental.count({
      where: { driverId: driver.id, state: { in: ['PENDING_SYNC', 'ACTIVE', 'ENDING_SYNC'] } },
    });
    expect(openRentals).toBe(1);
  });

  it('frees the driver and the bike once the rental is cancelled', async () => {
    const owner = await registerUser(ctx, 'OWNER');
    const driver = await createReadyDriver(ctx);
    const { bikeId } = await createPairedBike(ctx, owner);

    const first = await assignRental(ctx, owner, bikeId, driver.id);
    const rentalId = first.body.id as string;

    const cancelled = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/rentals/${rentalId}/cancel`,
      headers: auth(owner.accessToken),
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().state).toBe('CANCELLED');

    // The queued SET_ASSIGNMENT must not still be waiting for the device.
    const queued = await ctx.prisma.deviceCommand.count({
      where: { type: 'SET_ASSIGNMENT', status: 'QUEUED' },
    });
    expect(queued).toBe(0);

    const bike = await ctx.prisma.bike.findUniqueOrThrow({ where: { id: bikeId } });
    expect(bike.status).toBe('AVAILABLE');

    // A CANCELLED rental is not open, so the pair can be assigned again.
    const second = await assignRental(ctx, owner, bikeId, driver.id);
    expect(second.statusCode).toBe(201);
    expect(second.body.assignmentVersion).toBe(2);
  });
});

describe('Rental lifecycle (FR-RENT-03, FR-RENT-04)', () => {
  it('force-activate is allowed in DEMO_MODE and is flagged and audited', async () => {
    const owner = await registerUser(ctx, 'OWNER');
    const driver = await createReadyDriver(ctx);
    const { bikeId } = await createPairedBike(ctx, owner);

    const { body } = await assignRental(ctx, owner, bikeId, driver.id);
    const rentalId = body.id as string;

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/rentals/${rentalId}/force-activate`,
      headers: auth(owner.accessToken),
      payload: { confirm: true },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ state: 'ACTIVE', demoOverride: true });

    const rental = await ctx.prisma.rental.findUniqueOrThrow({ where: { id: rentalId } });
    // The device never acked, and the row says so honestly.
    expect(rental.demoOverride).toBe(true);
    expect(rental.deviceAckAt).toBeNull();
    expect(rental.startedAt).not.toBeNull();

    const audit = await ctx.prisma.auditEvent.findFirst({
      where: { action: 'RENTAL_FORCE_ACTIVATED', targetId: rentalId },
    });
    expect(audit).not.toBeNull();
  });

  it('ends an active rental into ENDING_SYNC and queues CLEAR_ASSIGNMENT', async () => {
    const owner = await registerUser(ctx, 'OWNER');
    const driver = await createReadyDriver(ctx);
    const { bikeId, deviceId } = await createPairedBike(ctx, owner);

    const { body } = await assignRental(ctx, owner, bikeId, driver.id);
    const rentalId = body.id as string;

    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/rentals/${rentalId}/force-activate`,
      headers: auth(owner.accessToken),
      payload: { confirm: true },
    });

    const ended = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/rentals/${rentalId}/end`,
      headers: auth(owner.accessToken),
      payload: { idempotencyKey: randomUUID() },
    });

    expect(ended.statusCode).toBe(200);
    // Only the device ack may move it to ENDED (§4.5.3).
    expect(ended.json().state).toBe('ENDING_SYNC');

    const command = await ctx.prisma.deviceCommand.findFirstOrThrow({
      where: { deviceId, type: 'CLEAR_ASSIGNMENT' },
    });
    expect(command.payload).toMatchObject({ rentalId, assignmentVersion: 1 });

    // ENDING_SYNC still counts as open, so the bike is not free yet.
    const reassign = await assignRental(ctx, owner, bikeId, driver.id);
    expect(reassign.statusCode).toBe(409);
  });

  it('refuses to end a rental that has not started, and to cancel one that has', async () => {
    const owner = await registerUser(ctx, 'OWNER');
    const driver = await createReadyDriver(ctx);
    const { bikeId } = await createPairedBike(ctx, owner);

    const { body } = await assignRental(ctx, owner, bikeId, driver.id);
    const rentalId = body.id as string;

    const endedTooEarly = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/rentals/${rentalId}/end`,
      headers: auth(owner.accessToken),
      payload: { idempotencyKey: randomUUID() },
    });
    expect(endedTooEarly.statusCode).toBe(409);
    expect(endedTooEarly.json().code).toBe('CONFLICT');

    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/rentals/${rentalId}/force-activate`,
      headers: auth(owner.accessToken),
      payload: { confirm: true },
    });

    const cancelledTooLate = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/rentals/${rentalId}/cancel`,
      headers: auth(owner.accessToken),
    });
    expect(cancelledTooLate.statusCode).toBe(409);
  });
});
