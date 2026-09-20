/**
 * §5.6.4 / FR-DRV-04 - recipient snapshots never change after assignment.
 *
 * This is the safety-critical one. The bike was handed a set of phone numbers
 * when the ride started and will text exactly those numbers after a crash; if
 * the server quietly re-pointed the rental at an edited contact, the incident
 * record would disagree with what the hardware actually did.
 */
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

describe('Emergency contact edits during an open rental (FR-DRV-04)', () => {
  it('leaves the rental snapshot untouched and says the change applies to the next rental', async () => {
    const owner = await registerUser(ctx, 'OWNER');
    const driver = await registerUser(ctx, 'DRIVER', { name: 'Ravi Kumar' });
    await setEmergencyContact(ctx, driver, {
      name: 'Kamala',
      phone: '+94712223344',
      relationship: 'Mother',
    });
    const { bikeId, deviceId } = await createPairedBike(ctx, owner);

    const { body } = await assignRental(ctx, owner, bikeId, driver.id);
    const rentalId = body.id as string;

    const before = await ctx.prisma.rental.findUniqueOrThrow({ where: { id: rentalId } });
    expect(before.contactNameSnapshot).toBe('Kamala');
    expect(before.contactPhoneSnapshot).toBe('+94712223344');

    // The driver changes their emergency contact mid-rental.
    const updated = await setEmergencyContact(ctx, driver, {
      name: 'Sunil',
      phone: '+94719998877',
      relationship: 'Brother',
    });
    expect(updated.statusCode).toBe(200);
    // The API is explicit rather than letting the UI imply otherwise.
    expect(updated.body.appliesTo).toBe('NEXT_RENTAL');

    const after = await ctx.prisma.rental.findUniqueOrThrow({ where: { id: rentalId } });
    expect(after.contactNameSnapshot).toBe('Kamala');
    expect(after.contactPhoneSnapshot).toBe('+94712223344');
    expect(after.driverNameSnapshot).toBe(before.driverNameSnapshot);
    expect(after.ownerPhoneSnapshot).toBe(before.ownerPhoneSnapshot);
    expect(after.emergencyContactId).toBe(before.emergencyContactId);

    // The owner-facing detail agrees with the row.
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/rentals/${rentalId}`,
      headers: auth(owner.accessToken),
    });
    expect(detail.json().snapshot).toMatchObject({
      contactName: 'Kamala',
      contactPhone: '+94712223344',
    });

    // And the bike was never told about the new number.
    const commands = await ctx.prisma.deviceCommand.findMany({ where: { deviceId } });
    expect(commands).toHaveLength(1);
    expect(commands[0]?.payload).toMatchObject({ contactName: 'Kamala', contactPhone: '+94712223344' });
  });

  it('keeps the old contact row so the historic snapshot stays resolvable', async () => {
    const driver = await registerUser(ctx, 'DRIVER');
    await setEmergencyContact(ctx, driver, {
      name: 'Kamala',
      phone: '+94712223344',
      relationship: 'Mother',
    });
    await setEmergencyContact(ctx, driver, {
      name: 'Sunil',
      phone: '+94719998877',
      relationship: 'Brother',
    });

    // FR-DRV-01: history is preserved, with exactly one row current.
    const all = await ctx.prisma.emergencyContact.findMany({
      where: { driverId: driver.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ name: 'Kamala', isCurrent: false });
    expect(all[1]).toMatchObject({ name: 'Sunil', isCurrent: true });

    const current = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/drivers/me/emergency-contact',
      headers: auth(driver.accessToken),
    });
    expect(current.json()).toMatchObject({ name: 'Sunil', phone: '+94719998877' });
  });

  it('uses the new contact for the next rental', async () => {
    const owner = await registerUser(ctx, 'OWNER');
    const driver = await createReadyDriver(ctx);
    const { bikeId } = await createPairedBike(ctx, owner);

    const first = await assignRental(ctx, owner, bikeId, driver.id);
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/rentals/${first.body.id as string}/cancel`,
      headers: auth(owner.accessToken),
    });

    const changed = await setEmergencyContact(ctx, driver, {
      name: 'Sunil',
      phone: '+94719998877',
      relationship: 'Brother',
    });
    // No open rental now, so the change is effective immediately.
    expect(changed.body.appliesTo).toBe('CURRENT');

    const second = await assignRental(ctx, owner, bikeId, driver.id);
    const rental = await ctx.prisma.rental.findUniqueOrThrow({
      where: { id: second.body.id as string },
    });
    expect(rental.contactNameSnapshot).toBe('Sunil');
    expect(rental.contactPhoneSnapshot).toBe('+94719998877');
  });

  it('does not follow a driver renaming their account either', async () => {
    const owner = await registerUser(ctx, 'OWNER');
    const driver = await createReadyDriver(ctx, 'Ravi Kumar');
    const { bikeId } = await createPairedBike(ctx, owner);

    const { body } = await assignRental(ctx, owner, bikeId, driver.id);

    await ctx.app.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers: auth(driver.accessToken),
      payload: { name: 'Ravi K.', phone: '+94700000009' },
    });

    const rental = await ctx.prisma.rental.findUniqueOrThrow({ where: { id: body.id as string } });
    expect(rental.driverNameSnapshot).toBe('Ravi Kumar');
    expect(rental.driverPhoneSnapshot).toBe(driver.phone);
  });
});
