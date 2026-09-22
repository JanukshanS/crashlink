/**
 * Fastify app assembly (§4.3).
 *
 * Built as a factory so tests can inject a fake clock, a shared Prisma client
 * and a recording realtime emitter, then drive it with `app.inject()` without
 * opening a socket.
 *
 * Two mount points, with different authentication (§5.3.1, §5.4.1):
 *  - `/api/v1` - app API, bearer JWT, JSON parsed by Fastify;
 *  - `/d/v1`   - device gateway, query-string HMAC, raw bodies. It lives in its
 *                own encapsulated scope so its raw-body parser cannot leak.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import { PrismaClient } from '@prisma/client';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { Config } from './config.js';
import { systemClock, toIsoRequired, type Clock } from './lib/time.js';
import { maskObject } from './lib/mask.js';
import { noopEmitter, type RealtimeEmitter } from './lib/realtime.js';
import { createPushSender } from './lib/push.js';
import prismaPlugin from './plugins/prisma.js';
import errorsPlugin from './plugins/errors.js';
import authPlugin from './plugins/auth.js';
import rateLimitPlugin from './plugins/rateLimit.js';
import socketPlugin from './plugins/socket.js';
import { registerAuthRoutes } from './modules/auth/routes.js';
import { registerUserRoutes } from './modules/users/routes.js';
import { registerDriverRoutes } from './modules/drivers/routes.js';
import { registerDriverIncidentRoutes } from './modules/drivers/pending.js';
import { registerBikeRoutes } from './modules/bikes/routes.js';
import { registerRentalRoutes } from './modules/rentals/routes.js';
import { registerAdminRoutes } from './modules/admin/routes.js';
import { registerIncidentRoutes } from './modules/incidents/routes.js';
import { registerAnalyticsRoutes } from './modules/analytics/routes.js';
import { registerDeviceRoutes } from './modules/devices/routes.js';
import { IncidentService } from './modules/incidents/service.js';
import { DecisionService } from './modules/incidents/decision.service.js';
import { DeviceIngestService } from './modules/devices/ingest.service.js';
import { ImageService } from './modules/images/service.js';
import { WorkerRunner } from './workers/index.js';

export interface AppDeps {
  config: Config;
  clock: Clock;
}

export interface BuildAppOptions {
  config: Config;
  /** Tests pass a FakeClock so deadline behaviour is deterministic (§4.3). */
  clock?: Clock;
  prisma?: PrismaClient;
  /** Tests pass a RecordingEmitter; production uses the Socket.IO plugin. */
  realtime?: RealtimeEmitter;
  /** Socket.IO is skipped under test - `app.inject()` never opens one. */
  enableSockets?: boolean;
  /** Workers are stepped by hand in tests rather than run on intervals. */
  enableWorkers?: boolean;
}

declare module 'fastify' {
  interface FastifyInstance {
    workers: WorkerRunner;
    /** Every route registered, for the NFR-05 "RBAC on every endpoint" sweep. */
    routeTable: { method: string; url: string }[];
    services: {
      incidents: IncidentService;
      decisions: DecisionService;
      ingest: DeviceIngestService;
      images: ImageService;
    };
  }
}

export const buildApp = async (options: BuildAppOptions): Promise<FastifyInstance> => {
  const { config } = options;
  const clock = options.clock ?? systemClock;
  const isTest = config.NODE_ENV === 'test';
  const enableSockets = options.enableSockets ?? !isTest;
  const enableWorkers = options.enableWorkers ?? !isTest;

  const app = Fastify({
    // §4.3: JSON logs with a request id on every line; phones masked (§5.7.3).
    logger: isTest
      ? false
      : {
          level: config.NODE_ENV === 'production' ? 'info' : 'debug',
          serializers: {
            req: (request) => ({
              method: request.method,
              // The device gateway carries its signature in the query string,
              // so the raw URL must never reach the log untouched.
              url: request.url?.split('?')[0],
              requestId: request.id,
            }),
            res: (reply) => ({ statusCode: reply.statusCode }),
          },
          hooks: {
            logMethod(args, method) {
              const [first, ...rest] = args;
              method.apply(this, [
                typeof first === 'object' ? (maskObject(first) as object) : first,
                ...rest,
              ] as Parameters<typeof method>);
            },
          },
        },
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });

  // Collected before any route is registered, so the table is complete.
  const routeTable: { method: string; url: string }[] = [];
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) routeTable.push({ method, url: route.url });
  });
  app.decorate('routeTable', routeTable);

  // §4.3: the zod type provider, so routes can declare zod schemas directly.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const deps: AppDeps = { config, clock };

  await app.register(errorsPlugin);
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: true, credentials: true });
  await app.register(prismaPlugin, options.prisma ? { client: options.prisma } : {});
  await app.register(authPlugin, {
    jwtSecret: config.JWT_SECRET,
    accessTokenTtlSec: config.ACCESS_TOKEN_TTL_SEC,
  });
  await app.register(rateLimitPlugin, { enabled: !isTest });

  if (enableSockets) await app.register(socketPlugin, {});

  // Services depend on the emitter interface, not on Socket.IO (§5.5).
  const realtime: RealtimeEmitter =
    options.realtime ?? (enableSockets ? app.realtime : noopEmitter);

  const push = createPushSender(app.prisma, config.FCM_SERVICE_ACCOUNT_JSON, app.log);

  const incidents = new IncidentService({
    prisma: app.prisma,
    clock,
    realtime,
    responseWindowSec: config.RESPONSE_WINDOW_SEC,
    push,
  });

  const decisions = new DecisionService({ prisma: app.prisma, clock, realtime });

  const images = new ImageService({
    prisma: app.prisma,
    clock,
    imageDir: config.IMAGE_DIR,
    maxBytes: config.IMAGE_MAX_BYTES,
    chunkMaxBytes: config.IMAGE_CHUNK_MAX_BYTES,
    fileUrlSecret: config.FILE_URL_SECRET,
    signedUrlTtlSec: config.SIGNED_URL_TTL_SEC,
  });

  const ingest = new DeviceIngestService({
    prisma: app.prisma,
    clock,
    realtime,
    incidents,
    decisions,
    responseWindowSec: config.RESPONSE_WINDOW_SEC,
  });

  app.decorate('services', { incidents, decisions, ingest, images });

  const workers = new WorkerRunner({
    prisma: app.prisma,
    clock,
    config,
    decisions,
    ingest,
    log: (message, meta) => app.log.info(meta ?? {}, message),
  });
  app.decorate('workers', workers);

  // §5.4.9: health sits at the root, not under /api/v1, so Uptime Kuma and the
  // container healthcheck do not depend on the API version.
  app.get('/health', async (_request, reply) => {
    let db: 'ok' | 'error' = 'ok';
    try {
      await app.prisma.$queryRaw`SELECT 1`;
    } catch {
      db = 'error';
    }

    // A probe that reads "ok" while the database is down is worse than no
    // probe, so the status follows the check rather than the happy-path example.
    const healthy = db === 'ok';
    return reply
      .status(healthy ? 200 : 503)
      .send({ status: healthy ? 'ok' : 'error', db, time: toIsoRequired(clock.now()) });
  });

  // --- app API (§5.4) -------------------------------------------------------
  await app.register(
    async (api) => {
      await registerAuthRoutes(api, deps);
      await registerUserRoutes(api, deps);
      await registerDriverRoutes(api, deps);
      await registerDriverIncidentRoutes(api, { realtime, app: deps });
      await registerBikeRoutes(api, deps);
      await registerRentalRoutes(api, deps);
      await registerIncidentRoutes(api, { decisions, images, app: deps });
      await registerAnalyticsRoutes(api, deps);
      await registerAdminRoutes(api, deps);
    },
    { prefix: '/api/v1' },
  );

  // --- device gateway (§5.3) ------------------------------------------------
  // Encapsulated: its raw-body content-type parser must not reach /api/v1.
  await app.register(
    async (gateway) => {
      await registerDeviceRoutes(gateway, { ingest, images, incidents, app: deps });
    },
    { prefix: '/d/v1' },
  );

  // Hooks must be registered before `ready()`; the workers themselves only
  // start once the app is fully wired.
  if (enableWorkers) app.addHook('onClose', async () => workers.stop());

  await app.ready();

  if (enableWorkers) workers.start();

  return app;
};
