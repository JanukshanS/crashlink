/**
 * §5.7.2 ownership scoping.
 *
 * Every owner/driver query is scoped, and another owner's id returns **404**,
 * not 403, so the API cannot be used to discover which ids exist. These helpers
 * are the only sanctioned way to turn a path parameter into a row.
 */
import type { PrismaClient } from '@prisma/client';
import type { AuthUser } from '../plugins/auth.js';
import { forbidden, notFound } from './errors.js';

/**
 * The owner whose data the caller may read.
 *
 * GUEST is a read-only judge account that sees the seeded demo owner's fleet
 * (§5.4.2, §5.7.2). There is no column linking a guest to an owner, so the demo
 * owner is resolved by convention: the earliest OWNER flagged `isDemo`.
 * TODO(spec): if more than one demo owner ever exists, add an explicit link
 * column rather than relying on creation order.
 */
export const resolveOwnerScopeId = async (
  prisma: PrismaClient,
  user: AuthUser,
): Promise<string> => {
  if (user.role === 'OWNER') return user.id;

  if (user.role === 'GUEST') {
    const demoOwner = await prisma.user.findFirst({
      where: { role: 'OWNER', isDemo: true },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (!demoOwner) throw notFound('Demo data');
    return demoOwner.id;
  }

  throw forbidden('This action requires an owner account.');
};

/** A bike the caller owns, or 404. */
export const assertOwnsBike = async (
  prisma: PrismaClient,
  ownerId: string,
  bikeId: string,
): Promise<{ id: string; ownerId: string; deviceId: string | null; label: string }> => {
  const bike = await prisma.bike.findFirst({
    where: { id: bikeId, ownerId },
    select: { id: true, ownerId: true, deviceId: true, label: true },
  });
  if (!bike) throw notFound('Bike');
  return bike;
};

/**
 * A rental the caller may see: an owner sees rentals on their own bikes, a
 * driver sees their own rentals (§5.7.2). Anything else is a 404.
 */
export const assertCanSeeRental = async (
  prisma: PrismaClient,
  user: AuthUser,
  rentalId: string,
  ownerScopeId?: string,
): Promise<{ id: string; ownerId: string; driverId: string }> => {
  const where =
    user.role === 'DRIVER'
      ? { id: rentalId, driverId: user.id }
      : { id: rentalId, ownerId: ownerScopeId ?? user.id };

  const rental = await prisma.rental.findFirst({
    where,
    select: { id: true, ownerId: true, driverId: true },
  });
  if (!rental) throw notFound('Rental');
  return rental;
};

/** An incident the caller may see (§5.7.2). Photo fields are stripped for drivers. */
export const assertCanSeeIncident = async (
  prisma: PrismaClient,
  user: AuthUser,
  incidentId: string,
  ownerScopeId?: string,
): Promise<{ id: string; ownerId: string; driverId: string | null }> => {
  const where =
    user.role === 'DRIVER'
      ? { id: incidentId, driverId: user.id }
      : { id: incidentId, ownerId: ownerScopeId ?? user.id };

  const incident = await prisma.incident.findFirst({
    where,
    select: { id: true, ownerId: true, driverId: true },
  });
  if (!incident) throw notFound('Incident');
  return incident;
};
