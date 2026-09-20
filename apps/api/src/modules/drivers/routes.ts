/**
 * §5.4.3 Driver routes - emergency contact (FR-DRV-01, FR-DRV-04) and the
 * owner-facing driver lookup.
 *
 * Implemented here: `GET/PUT /drivers/me/emergency-contact` and
 * `GET /drivers/lookup`. The remaining §5.4.3 routes (active-rental,
 * pending-question, responses, sos, rentals, incidents) belong to the incident
 * and realtime work and are not part of this task.
 */
import type { FastifyInstance } from 'fastify';
import {
  DriverLookupQuerySchema,
  OPEN_RENTAL_STATES,
  UpsertEmergencyContactRequestSchema,
  maskPhone,
} from '@crashlink/contracts';
import { requireUser } from '../../plugins/auth.js';
import { notFound } from '../../lib/errors.js';
import { toIsoRequired } from '../../lib/time.js';
import type { AppDeps } from '../../app.js';

export const registerDriverRoutes = async (app: FastifyInstance, _deps: AppDeps): Promise<void> => {
  const driverOnly = [app.authenticate, app.requireRole('DRIVER')];
  const ownerOnly = [app.authenticate, app.requireRole('OWNER')];

  app.get('/drivers/me/emergency-contact', { preHandler: driverOnly }, async (request, reply) => {
    const auth = requireUser(request);

    const contact = await app.prisma.emergencyContact.findFirst({
      where: { driverId: auth.id, isCurrent: true },
    });
    if (!contact) throw notFound('Emergency contact');

    return reply.send({
      id: contact.id,
      name: contact.name,
      phone: contact.phoneE164,
      relationship: contact.relationship,
      updatedAt: toIsoRequired(contact.updatedAt),
    });
  });

  /**
   * FR-DRV-01: an update creates a new row and retires the old one, so the
   * contact a past rental was assigned against is still readable.
   *
   * FR-DRV-04: an open rental keeps the snapshot taken at assignment, so the
   * change applies to the NEXT rental - and the response says so rather than
   * letting the UI imply the bike now has the new number.
   */
  app.put('/drivers/me/emergency-contact', { preHandler: driverOnly }, async (request, reply) => {
    const auth = requireUser(request);
    const body = UpsertEmergencyContactRequestSchema.parse(request.body);

    const openRentalCount = await app.prisma.rental.count({
      where: { driverId: auth.id, state: { in: [...OPEN_RENTAL_STATES] } },
    });

    const contact = await app.prisma.$transaction(async (tx) => {
      // Retire the old row first: `emergency_contacts_one_current` (§5.6.3)
      // permits only one current contact per driver.
      await tx.emergencyContact.updateMany({
        where: { driverId: auth.id, isCurrent: true },
        data: { isCurrent: false },
      });

      return tx.emergencyContact.create({
        data: {
          driverId: auth.id,
          name: body.name,
          phoneE164: body.phone,
          relationship: body.relationship,
          isCurrent: true,
        },
      });
    });

    return reply.send({
      id: contact.id,
      name: contact.name,
      phone: contact.phoneE164,
      relationship: contact.relationship,
      updatedAt: toIsoRequired(contact.updatedAt),
      appliesTo: openRentalCount > 0 ? 'NEXT_RENTAL' : 'CURRENT',
    });
  });

  /**
   * §5.4.3 `GET /drivers/lookup?q=` - exact match on phone or email only.
   * No partial or fuzzy search: an owner should not be able to enumerate the
   * driver directory. The phone comes back masked (§5.7.3).
   */
  app.get('/drivers/lookup', { preHandler: ownerOnly }, async (request, reply) => {
    const query = DriverLookupQuerySchema.parse(request.query);
    const q = query.q.trim();

    const driver = await app.prisma.user.findFirst({
      where: {
        role: 'DRIVER',
        disabledAt: null,
        ...(q.startsWith('+') ? { phoneE164: q } : { email: q.toLowerCase() }),
      },
      select: { id: true, name: true, phoneE164: true },
    });
    if (!driver) throw notFound('Driver');

    const [contactCount, openRentalCount] = await Promise.all([
      app.prisma.emergencyContact.count({ where: { driverId: driver.id, isCurrent: true } }),
      app.prisma.rental.count({
        where: { driverId: driver.id, state: { in: [...OPEN_RENTAL_STATES] } },
      }),
    ]);

    return reply.send({
      id: driver.id,
      name: driver.name,
      phoneMasked: maskPhone(driver.phoneE164),
      hasEmergencyContact: contactCount > 0,
      busy: openRentalCount > 0,
    });
  });

};
