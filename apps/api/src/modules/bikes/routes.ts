/**
 * §5.4.4 Bikes & devices (owner) - CRUD and pairing.
 *
 * Implemented here: list, create, detail, update, pair, unpair. The remaining
 * §5.4.4 routes (locations, ignition-events, device-config, demo-trigger)
 * depend on the device gateway and are not part of this task.
 *
 * Every read is ownership-scoped; another owner's bike id is a 404 (§5.7.2).
 * GUEST may read the demo owner's fleet and is blocked from every mutation by
 * the global guard in plugins/auth.ts.
 */
import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import {
  CreateBikeRequestSchema,
  DeviceConfigSchema,
  ListBikesQuerySchema,
  OPEN_INCIDENT_STATES,
  OPEN_RENTAL_STATES,
  PairDeviceRequestSchema,
  UpdateBikeRequestSchema,
} from '@crashlink/contracts';
import { requireUser } from '../../plugins/auth.js';
import { assertOwnsBike, resolveReadScope, scopeWhere } from '../../lib/ownership.js';
import { conflict, notFound, validationFailed } from '../../lib/errors.js';
import { routeRateLimit } from '../../lib/routeConfig.js';
import { zonedDayStart } from '../../lib/time.js';
import { ignitionSpans } from '../../lib/ignition.js';
import { buildBikeSummary, buildHealthDto, bikeInclude, type BikeWithRelations } from './service.js';
import type { AppDeps } from '../../app.js';

export const registerBikeRoutes = async (app: FastifyInstance, deps: AppDeps): Promise<void> => {
  // §5.7.2 Bikes: OWNER RW own, GUEST R demo, ADMIN R all.
  const readers = [app.authenticate, app.requireRole('OWNER', 'GUEST', 'ADMIN')];
  const ownerOnly = [app.authenticate, app.requireRole('OWNER')];

  const openIncidentCounts = async (bikeIds: string[]): Promise<Map<string, number>> => {
    if (bikeIds.length === 0) return new Map();
    const rows = await app.prisma.incident.groupBy({
      by: ['bikeId'],
      where: { bikeId: { in: bikeIds }, state: { in: [...OPEN_INCIDENT_STATES] } },
      _count: { _all: true },
    });
    return new Map(rows.map((row) => [row.bikeId, row._count._all]));
  };

  app.get('/bikes', { preHandler: readers }, async (request, reply) => {
    const auth = requireUser(request);
    const scope = await resolveReadScope(app.prisma, auth);
    const query = ListBikesQuerySchema.parse(request.query ?? {});
    const now = deps.clock.now();

    const bikes = (await app.prisma.bike.findMany({
      where: { ...scopeWhere(scope), ...(query.status ? { status: query.status } : {}) },
      include: bikeInclude(OPEN_RENTAL_STATES),
      orderBy: { createdAt: 'asc' },
    })) as unknown as BikeWithRelations[];

    const counts = await openIncidentCounts(bikes.map((bike) => bike.id));

    return reply.send({
      items: bikes.map((bike) => buildBikeSummary(bike, counts.get(bike.id) ?? 0, now)),
    });
  });

  app.post('/bikes', { preHandler: ownerOnly }, async (request, reply) => {
    const auth = requireUser(request);
    const body = CreateBikeRequestSchema.parse(request.body);
    const now = deps.clock.now();

    const bike = (await app.prisma.bike.create({
      data: {
        ownerId: auth.id,
        label: body.label,
        ...(body.plateNo !== undefined ? { plateNo: body.plateNo } : {}),
        isDemo: auth.isDemo,
      },
      include: bikeInclude(OPEN_RENTAL_STATES),
    })) as unknown as BikeWithRelations;

    return reply.status(201).send(buildBikeSummary(bike, 0, now));
  });

  app.get<{ Params: { id: string } }>('/bikes/:id', { preHandler: readers }, async (request, reply) => {
    const auth = requireUser(request);
    const scope = await resolveReadScope(app.prisma, auth);
    const now = deps.clock.now();

    const bike = (await app.prisma.bike.findFirst({
      where: { id: request.params.id, ...scopeWhere(scope) },
      include: bikeInclude(OPEN_RENTAL_STATES),
    })) as unknown as BikeWithRelations | null;
    if (!bike) throw notFound('Bike');

    const counts = await openIncidentCounts([bike.id]);
    const parsedConfig = bike.device ? DeviceConfigSchema.safeParse(bike.device.config) : null;

    // §5.6.5 / FR-RENT-06: riding and parked time today, walked from
    // ignition_events. "Today" is the owner's local day (TZ_DISPLAY), since
    // that is the day they mean when they read the number.
    const dayStart = zonedDayStart(now, deps.config.TZ_DISPLAY);

    const [before, today] = await Promise.all([
      app.prisma.ignitionEvent.findFirst({
        where: { bikeId: bike.id, changedAt: { lte: dayStart } },
        orderBy: { changedAt: 'desc' },
        select: { state: true },
      }),
      app.prisma.ignitionEvent.findMany({
        where: { bikeId: bike.id, changedAt: { gt: dayStart, lte: now } },
        orderBy: { changedAt: 'asc' },
        select: { state: true, changedAt: true },
      }),
    ]);

    const spans = ignitionSpans(
      before?.state ?? 'UNKNOWN',
      today.map((event) => ({ state: event.state, at: event.changedAt })),
      dayStart,
      now,
    );

    // "Parked for X min" (FR-RENT-06) only makes sense while it is parked.
    const parkedSinceSec =
      bike.ignition === 'OFF' && bike.ignitionChangedAt
        ? Math.max(0, Math.round((now.getTime() - bike.ignitionChangedAt.getTime()) / 1000))
        : null;

    return reply.send({
      ...buildBikeSummary(bike, counts.get(bike.id) ?? 0, now),
      health: buildHealthDto(bike.device),
      config: parsedConfig?.success ? parsedConfig.data : null,
      ridingSecToday: spans.ridingSec,
      parkedSecToday: spans.parkedSec,
      // Time today before the bike first reported a state. Shown as such rather
      // than silently counted as parked.
      unknownSecToday: spans.unknownSec,
      parkedSinceSec,
    });
  });

  app.patch<{ Params: { id: string } }>('/bikes/:id', { preHandler: ownerOnly }, async (request, reply) => {
    const auth = requireUser(request);
    const body = UpdateBikeRequestSchema.parse(request.body);
    const now = deps.clock.now();

    await assertOwnsBike(app.prisma, auth.id, request.params.id);

    // A bike with an open rental is RENTED; the owner may rename it but not
    // move it to MAINTENANCE underneath a rider.
    if (body.status) {
      const openRentals = await app.prisma.rental.count({
        where: { bikeId: request.params.id, state: { in: [...OPEN_RENTAL_STATES] } },
      });
      if (openRentals > 0) {
        throw conflict('RENTAL_ACTIVE_EXISTS', 'End the open rental before changing the bike status.');
      }
    }

    const bike = (await app.prisma.bike.update({
      where: { id: request.params.id },
      data: {
        ...(body.label !== undefined ? { label: body.label } : {}),
        ...(body.plateNo !== undefined ? { plateNo: body.plateNo } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
      },
      include: bikeInclude(OPEN_RENTAL_STATES),
    })) as unknown as BikeWithRelations;

    const counts = await openIncidentCounts([bike.id]);
    return reply.send(buildBikeSummary(bike, counts.get(bike.id) ?? 0, now));
  });

  /**
   * FR-DEV-02 pairing. The pairing code is bcrypt-hashed at provisioning, so a
   * database leak does not hand out the right to claim a device. Rate-limited
   * to 5/min per user (§5.4.10) because it is guessable by construction.
   */
  app.post<{ Params: { id: string } }>(
    '/bikes/:id/pair',
    {
      preHandler: ownerOnly,
      config: routeRateLimit(deps.config.NODE_ENV !== 'test', 5),
    },
    async (request, reply) => {
      const auth = requireUser(request);
      const body = PairDeviceRequestSchema.parse(request.body);
      const now = deps.clock.now();

      const bike = await assertOwnsBike(app.prisma, auth.id, request.params.id);

      const device = await app.prisma.device.findUnique({
        where: { code: body.deviceCode },
        include: { bike: { select: { id: true } } },
      });

      // A wrong device code and a wrong pairing code are the same answer, so
      // this endpoint cannot be used to learn which codes exist.
      if (!device || device.revokedAt) throw validationFailed('Device code or pairing code is incorrect.');

      const pairingOk = await bcrypt.compare(body.pairingCode, device.pairingCodeHash);
      if (!pairingOk) throw validationFailed('Device code or pairing code is incorrect.');

      if (device.bike && device.bike.id !== bike.id) {
        throw conflict('DEVICE_ALREADY_PAIRED', 'That device is already paired to another bike.');
      }
      if (bike.deviceId && bike.deviceId !== device.id) {
        throw conflict('DEVICE_ALREADY_PAIRED', 'This bike is already paired to a different device.');
      }

      const updated = (await app.prisma.bike.update({
        where: { id: bike.id },
        data: { deviceId: device.id },
        include: bikeInclude(OPEN_RENTAL_STATES),
      })) as unknown as BikeWithRelations;

      // §5.7.3: pairing is an audited event.
      await app.prisma.auditEvent.create({
        data: {
          actorType: 'USER',
          actorId: auth.id,
          action: 'BIKE_PAIRED',
          targetType: 'BIKE',
          targetId: bike.id,
          meta: { deviceCode: device.code },
        },
      });

      const counts = await openIncidentCounts([bike.id]);
      return reply.send(buildBikeSummary(updated, counts.get(bike.id) ?? 0, now));
    },
  );

  /** FR-DEV-03: unpair only when the bike has no open rental. */
  app.delete<{ Params: { id: string } }>(
    '/bikes/:id/pair',
    { preHandler: ownerOnly },
    async (request, reply) => {
      const auth = requireUser(request);
      const bike = await assertOwnsBike(app.prisma, auth.id, request.params.id);

      if (!bike.deviceId) throw conflict('DEVICE_NOT_PAIRED', 'This bike has no paired device.');

      const openRentals = await app.prisma.rental.count({
        where: { bikeId: bike.id, state: { in: [...OPEN_RENTAL_STATES] } },
      });
      if (openRentals > 0) {
        throw conflict('RENTAL_ACTIVE_EXISTS', 'End the open rental before unpairing the device.');
      }

      await app.prisma.bike.update({ where: { id: bike.id }, data: { deviceId: null } });

      await app.prisma.auditEvent.create({
        data: {
          actorType: 'USER',
          actorId: auth.id,
          action: 'BIKE_UNPAIRED',
          targetType: 'BIKE',
          targetId: bike.id,
          meta: {},
        },
      });

      return reply.status(204).send();
    },
  );
};
