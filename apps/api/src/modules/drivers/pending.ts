/**
 * §5.4.3 driver routes that depend on incidents: active rental, the pending
 * safety question (FR-NOT-05, polled every 5 s as the socket's fallback), the
 * driver's own history, and app SOS (FR-INC-13).
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import {
  OPEN_RENTAL_STATES,
  PaginationQuerySchema,
  UuidSchema,
  incidentTypeLabel,
  maskPhone,
} from '@crashlink/contracts';
import { z } from 'zod';
import { requireUser } from '../../plugins/auth.js';
import { toIso, toIsoRequired } from '../../lib/time.js';
import { buildLocationDto, deviceOnlineState } from '../bikes/service.js';
import { stampIntegrityHash, toIncidentSummary } from '../incidents/service.js';
import { ensureNotification } from '../notifications/service.js';
import type { RealtimeEmitter } from '../../lib/realtime.js';
import type { AppDeps } from '../../app.js';

const SosRequestSchema = z.object({
  idempotencyKey: UuidSchema,
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional(),
});

export interface DriverIncidentRoutesDeps {
  realtime: RealtimeEmitter;
  app: AppDeps;
}

export const registerDriverIncidentRoutes = async (
  app: FastifyInstance,
  deps: DriverIncidentRoutesDeps,
): Promise<void> => {
  const { clock } = deps.app;
  const driverOnly = [app.authenticate, app.requireRole('DRIVER')];

  // --- §5.4.3 active rental (FR-DRV-02) ------------------------------------
  app.get('/drivers/me/active-rental', { preHandler: driverOnly }, async (request, reply) => {
    const auth = requireUser(request);
    const now = clock.now();

    const rental = await app.prisma.rental.findFirst({
      where: { driverId: auth.id, state: { in: [...OPEN_RENTAL_STATES] } },
      include: {
        bike: { include: { device: true } },
        owner: { select: { name: true, phoneE164: true } },
      },
    });

    if (!rental) return reply.send({ rental: null });

    return reply.send({
      rental: {
        id: rental.id,
        state: rental.state,
        startedAt: toIso(rental.startedAt),
        distanceM: rental.distanceMeters,
        bike: {
          label: rental.bike.label,
          ignition: {
            state: rental.bike.ignition,
            changedAt: toIso(rental.bike.ignitionChangedAt),
          },
          location: buildLocationDto(rental.bike, now),
          // FR-DRV-02: the rider can see whether the bike is actually reporting.
          deviceOnline: rental.bike.device
            ? deviceOnlineState(
                rental.bike.device.lastSeenAt,
                rental.bike.ignition === 'ON',
                rental.bike.device.config,
                now,
              )
            : 'OFFLINE',
        },
        ownerName: rental.owner.name,
        // §5.7.3: the driver never gets the owner's full number.
        ownerPhone: maskPhone(rental.owner.phoneE164),
      },
    });
  });

  // --- §5.4.3 pending question (FR-NOT-05) ---------------------------------
  /**
   * The 5 s poll the app runs while a rental is active. It is the fallback for
   * the socket, so it must be cheap and must return the server's clock: the
   * countdown the rider sees is driven by `responseDeadlineAt` minus
   * `serverTime`, never by the handset's own clock.
   */
  app.get('/drivers/me/pending-question', { preHandler: driverOnly }, async (request, reply) => {
    const auth = requireUser(request);
    const now = clock.now();

    const incident = await app.prisma.incident.findFirst({
      where: {
        driverId: auth.id,
        decision: 'PENDING',
        serverQuestion: true,
        responseDeadlineAt: { gt: now },
      },
      orderBy: { occurredAt: 'desc' },
      include: { responses: { where: { responderUserId: auth.id }, take: 1 } },
    });

    if (!incident || !incident.questionSentAt || !incident.responseDeadlineAt) {
      return reply.send({ serverTime: toIsoRequired(now), question: null });
    }

    return reply.send({
      serverTime: toIsoRequired(now),
      question: {
        incidentId: incident.id,
        type: incident.type,
        label: incidentTypeLabel(incident.type),
        occurredAt: toIsoRequired(incident.occurredAt),
        questionSentAt: toIsoRequired(incident.questionSentAt),
        responseDeadlineAt: toIsoRequired(incident.responseDeadlineAt),
        myResponse: incident.responses[0]?.choice ?? null,
      },
    });
  });

  // --- §5.4.3 driver history (FR-DRV-03) -----------------------------------
  app.get('/drivers/me/rentals', { preHandler: driverOnly }, async (request, reply) => {
    const auth = requireUser(request);
    const page = PaginationQuerySchema.parse(request.query ?? {});

    const rentals = await app.prisma.rental.findMany({
      where: { driverId: auth.id },
      include: { bike: { select: { label: true } }, _count: { select: { incidents: true } } },
      orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
      take: page.limit + 1,
      ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
    });

    const hasMore = rentals.length > page.limit;
    const items = hasMore ? rentals.slice(0, page.limit) : rentals;

    return reply.send({
      items: items.map((rental) => ({
        id: rental.id,
        bikeLabel: rental.bike.label,
        startedAt: toIso(rental.startedAt),
        endedAt: toIso(rental.endedAt),
        distanceM: rental.distanceMeters,
        incidentCount: rental._count.incidents,
      })),
      nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null,
    });
  });

  /** FR-DRV-03: a driver's own incidents, with no photo fields at all. */
  app.get('/drivers/me/incidents', { preHandler: driverOnly }, async (request, reply) => {
    const auth = requireUser(request);
    const page = PaginationQuerySchema.parse(request.query ?? {});

    const rows = await app.prisma.incident.findMany({
      where: { driverId: auth.id },
      include: { bike: { select: { label: true } } },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: page.limit + 1,
      ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > page.limit;
    const items = hasMore ? rows.slice(0, page.limit) : rows;

    return reply.send({
      items: items.map((row) => {
        const { photoStatus: _photoStatus, ...summary } = toIncidentSummary(row as never);
        return summary;
      }),
      nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null,
    });
  });

  // --- §5.4.3 app SOS (FR-INC-13) ------------------------------------------
  /**
   * The rider's own panic button. It escalates immediately - there is no
   * question to ask someone who just told us they need help (§5.3.5 step 5).
   */
  app.post('/drivers/me/sos', { preHandler: driverOnly }, async (request, reply) => {
    const auth = requireUser(request);
    const body = SosRequestSchema.parse(request.body ?? {});
    const now = clock.now();

    const replay = await app.prisma.idempotencyRecord.findUnique({
      where: { key: body.idempotencyKey },
    });
    if (replay) return reply.status(201).send(replay.response);

    const rental = await app.prisma.rental.findFirst({
      where: { driverId: auth.id, state: { in: [...OPEN_RENTAL_STATES] } },
      include: { bike: true },
    });
    if (!rental) {
      // Without a rental there is no bike, no contact snapshot and nothing to
      // text. Saying so is better than recording an alert nobody will act on.
      return reply.status(409).send({
        code: 'CONFLICT',
        message: 'You need an active rental to raise an SOS.',
        requestId: request.id,
        details: {},
      });
    }

    const hasFix = body.lat !== undefined && body.lon !== undefined;

    const incident = await app.prisma.$transaction(async (tx) => {
      const created = await tx.incident.create({
        data: {
          // §5.6.4: server-generated id, because this one did not come from the
          // device's event stream.
          id: randomUUID(),
          bikeId: rental.bikeId,
          deviceId: rental.bike.deviceId,
          rentalId: rental.id,
          driverId: auth.id,
          ownerId: rental.ownerId,
          type: 'MANUAL_SOS',
          category: 'EMERGENCY',
          state: 'ESCALATED',
          occurredAt: now,
          receivedAt: now,
          timeSource: 'SERVER_SYNC',
          ignitionAtEvent: rental.bike.ignition,
          locationKind: hasFix ? 'LIVE' : 'UNAVAILABLE',
          lat: body.lat ?? null,
          lon: body.lon ?? null,
          fixAt: hasFix ? now : null,
          fixAgeSec: hasFix ? 0 : null,
          locationSource: hasFix ? 'GPS' : null,
          evidence: { simulated: false, source: 'APP_SOS' } as Prisma.InputJsonValue,
          assignmentVersion: rental.assignmentVersion,
          ownerPhoneSnapshot: rental.ownerPhoneSnapshot,
          driverNameSnapshot: rental.driverNameSnapshot,
          contactNameSnapshot: rental.contactNameSnapshot,
          contactPhoneSnapshot: rental.contactPhoneSnapshot,
          serverQuestion: false,
          decision: 'HELP',
          decisionSource: 'APP',
          decidedAt: now,
          isDemo: rental.bike.isDemo,
        },
        include: { bike: { select: { label: true } } },
      });

      // D3: HELP means the emergency contact is being texted - exactly once.
      await ensureNotification(tx, {
        incidentId: created.id,
        kind: 'CONTACT_SMS',
        recipientPhone: rental.contactPhoneSnapshot,
        state: 'REQUESTED',
        at: now,
      });
      await ensureNotification(tx, {
        incidentId: created.id,
        kind: 'OWNER_PUSH',
        state: 'REQUESTED',
        at: now,
      });

      // FR-INC-11: an app SOS carries an integrity hash like any other incident.
      await stampIntegrityHash(tx, created.id, null);

      // §5.3.4: tell the bike, so it sends the SMS and stops asking.
      if (rental.bike.deviceId) {
        await tx.deviceCommand.create({
          data: {
            deviceId: rental.bike.deviceId,
            type: 'INCIDENT_DECISION',
            payload: { eventId: created.id, decision: 'HELP' } as Prisma.InputJsonValue,
            incidentId: created.id,
            status: 'QUEUED',
            expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
          },
        });
      }

      await tx.idempotencyRecord.create({
        data: {
          key: body.idempotencyKey,
          userId: auth.id,
          route: 'POST /drivers/me/sos',
          statusCode: 201,
          response: { incidentId: created.id, state: 'ESCALATED' } as Prisma.InputJsonValue,
        },
      });

      return created;
    });

    deps.realtime.toOwner(rental.ownerId, 'incident.created', toIncidentSummary(incident as never));

    return reply.status(201).send({ incidentId: incident.id, state: 'ESCALATED' });
  });
};
