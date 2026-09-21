/**
 * §5.4.7 Analytics & dashboard - exactly the six routes in the spec table.
 *
 * Roles: OWNER + GUEST as the §5.4.7 table says (the judge reads the demo
 * owner's fleet), plus ADMIN, whom §5.7.2 grants "All" analytics.
 * `response-outcomes` stays closed to GUEST, as the table lists it OWNER only.
 */
import type { FastifyInstance } from 'fastify';
import { AnalyticsRangeQuerySchema, IncidentsTimeseriesQuerySchema } from '@crashlink/contracts';
import { requireUser } from '../../plugins/auth.js';
import { resolveReadScope } from '../../lib/ownership.js';
import { AnalyticsService } from './service.js';
import type { AppDeps } from '../../app.js';

export const registerAnalyticsRoutes = async (app: FastifyInstance, deps: AppDeps): Promise<void> => {
  const service = new AnalyticsService({
    prisma: app.prisma,
    clock: deps.clock,
    timeZone: deps.config.TZ_DISPLAY,
  });

  // §5.7.2 Analytics: OWNER own fleet, GUEST demo, ADMIN all.
  const readers = [app.authenticate, app.requireRole('OWNER', 'GUEST', 'ADMIN')];
  // §5.4.7 lists response-outcomes as OWNER; §5.7.2 grants ADMIN all analytics.
  const outcomeReaders = [app.authenticate, app.requireRole('OWNER', 'ADMIN')];

  /** Scope once, then every query below is confined to this owner. */
  const scope = async (request: Parameters<typeof requireUser>[0]) =>
    resolveReadScope(app.prisma, requireUser(request));

  app.get('/owners/me/dashboard', { preHandler: readers }, async (request, reply) => {
    const readScope = await scope(request);
    return reply.send(await service.dashboard(readScope));
  });

  app.get('/analytics/incidents-by-type', { preHandler: readers }, async (request, reply) => {
    const readScope = await scope(request);
    const range = service.resolveRange(AnalyticsRangeQuerySchema.parse(request.query ?? {}));
    return reply.send(await service.incidentsByType(readScope, range));
  });

  app.get('/analytics/incidents-timeseries', { preHandler: readers }, async (request, reply) => {
    const readScope = await scope(request);
    const query = IncidentsTimeseriesQuerySchema.parse(request.query ?? {});
    const range = service.resolveRange(query);
    return reply.send(await service.incidentsTimeseries(readScope, range));
  });

  app.get('/analytics/distance-by-bike', { preHandler: readers }, async (request, reply) => {
    const readScope = await scope(request);
    const range = service.resolveRange(AnalyticsRangeQuerySchema.parse(request.query ?? {}));
    return reply.send(await service.distanceByBike(readScope, range));
  });

  app.get('/analytics/response-outcomes', { preHandler: outcomeReaders }, async (request, reply) => {
    const readScope = await scope(request);
    const range = service.resolveRange(AnalyticsRangeQuerySchema.parse(request.query ?? {}));
    return reply.send(await service.responseOutcomes(readScope, range));
  });

  app.get('/analytics/potholes', { preHandler: readers }, async (request, reply) => {
    const readScope = await scope(request);
    const range = service.resolveRange(AnalyticsRangeQuerySchema.parse(request.query ?? {}));
    return reply.send(await service.potholes(readScope, range));
  });
};
