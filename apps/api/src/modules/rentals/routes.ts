/**
 * §5.4.5 Rentals.
 *
 * An OWNER sees rentals on their own bikes; a DRIVER sees only their own, with
 * the snapshot phone numbers masked (§5.7.2, §5.7.3). Anyone else asking for
 * the id gets a 404.
 */
import type { FastifyInstance } from 'fastify';
import {
  CreateRentalRequestSchema,
  EndRentalRequestSchema,
  ForceActivateRequestSchema,
  ListRentalsQuerySchema,
  PaginationQuerySchema,
  incidentTypeLabel,
  maskPhone,
} from '@crashlink/contracts';
import { requireUser } from '../../plugins/auth.js';
import { assertCanSeeRental, resolveOwnerScopeId } from '../../lib/ownership.js';
import { notFound } from '../../lib/errors.js';
import { toIso, toIsoRequired } from '../../lib/time.js';
import { severityOf } from '../../lib/severity.js';
import { RentalService, toRentalSummary } from './service.js';
import type { AppDeps } from '../../app.js';

export const registerRentalRoutes = async (app: FastifyInstance, deps: AppDeps): Promise<void> => {
  const service = new RentalService({
    prisma: app.prisma,
    clock: deps.clock,
    demoMode: deps.config.DEMO_MODE,
  });

  const ownerOnly = [app.authenticate, app.requireRole('OWNER')];
  const ownerOrDriver = [app.authenticate, app.requireRole('OWNER', 'DRIVER')];

  app.post('/rentals', { preHandler: ownerOnly }, async (request, reply) => {
    const auth = requireUser(request);
    const body = CreateRentalRequestSchema.parse(request.body);
    return reply.status(201).send(await service.assign(auth.id, body));
  });

  app.post<{ Params: { id: string } }>(
    '/rentals/:id/cancel',
    { preHandler: ownerOnly },
    async (request, reply) => {
      const auth = requireUser(request);
      return reply.send(await service.cancel(auth.id, request.params.id));
    },
  );

  app.post<{ Params: { id: string } }>(
    '/rentals/:id/end',
    { preHandler: ownerOnly },
    async (request, reply) => {
      const auth = requireUser(request);
      const body = EndRentalRequestSchema.parse(request.body);
      return reply.send(await service.end(auth.id, request.params.id, body.idempotencyKey));
    },
  );

  app.post<{ Params: { id: string } }>(
    '/rentals/:id/force-activate',
    { preHandler: ownerOnly },
    async (request, reply) => {
      const auth = requireUser(request);
      ForceActivateRequestSchema.parse(request.body);
      return reply.send(await service.forceActivate(auth.id, request.params.id));
    },
  );

  app.get('/rentals', { preHandler: ownerOnly }, async (request, reply) => {
    const auth = requireUser(request);
    const filters = ListRentalsQuerySchema.parse(request.query ?? {});
    const page = PaginationQuerySchema.parse(request.query ?? {});

    const rentals = await app.prisma.rental.findMany({
      where: {
        ownerId: auth.id,
        ...(filters.state ? { state: filters.state } : {}),
        ...(filters.bikeId ? { bikeId: filters.bikeId } : {}),
      },
      include: { bike: { select: { label: true } }, driver: { select: { name: true } } },
      orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
      take: page.limit + 1,
      ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
    });

    const hasMore = rentals.length > page.limit;
    const items = hasMore ? rentals.slice(0, page.limit) : rentals;

    return reply.send({
      items: items.map(toRentalSummary),
      nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null,
    });
  });

  app.get<{ Params: { id: string } }>(
    '/rentals/:id',
    { preHandler: ownerOrDriver },
    async (request, reply) => {
      const auth = requireUser(request);
      const ownerScopeId = auth.role === 'DRIVER' ? undefined : await resolveOwnerScopeId(app.prisma, auth);

      await assertCanSeeRental(app.prisma, auth, request.params.id, ownerScopeId);

      const rental = await app.prisma.rental.findUnique({
        where: { id: request.params.id },
        include: {
          bike: { select: { label: true } },
          driver: { select: { name: true } },
          incidents: { orderBy: { occurredAt: 'desc' } },
        },
      });
      if (!rental) throw notFound('Rental');

      // §5.7.3: a driver sees masked numbers even on their own rental; only the
      // owner sees the full recipients their bike will actually text.
      const isDriver = auth.role === 'DRIVER';
      const show = (phone: string | null): string | null =>
        isDriver ? maskPhone(phone) : phone;

      return reply.send({
        ...toRentalSummary(rental),
        snapshot: {
          ownerPhone: show(rental.ownerPhoneSnapshot),
          driverName: rental.driverNameSnapshot,
          driverPhone: show(rental.driverPhoneSnapshot),
          contactName: rental.contactNameSnapshot,
          contactPhone: show(rental.contactPhoneSnapshot),
        },
        sync: {
          requestedAt: toIsoRequired(rental.requestedAt),
          deviceAckAt: toIso(rental.deviceAckAt),
          endRequestedAt: toIso(rental.endRequestedAt),
          endedAt: toIso(rental.endedAt),
        },
        incidents: rental.incidents.map((incident) => ({
          id: incident.id,
          bikeId: incident.bikeId,
          bikeLabel: rental.bike.label,
          type: incident.type,
          category: incident.category,
          label: incidentTypeLabel(incident.type),
          state: incident.state,
          decision: incident.decision,
          severity: severityOf(incident.severityScore, incident.type),
          occurredAt: toIsoRequired(incident.occurredAt),
          responseDeadlineAt: toIso(incident.responseDeadlineAt),
          // §5.4.3/§5.7.2: a driver gets no photo fields at all. The field is
          // omitted rather than reported as NOT_REQUESTED, which would state
          // something untrue about an incident that does have a photo.
          ...(isDriver ? {} : { photoStatus: incident.photoStatus }),
          quarantined: incident.quarantined,
          isDemo: incident.isDemo,
        })),
      });
    },
  );
};
