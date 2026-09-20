/**
 * Fastify app assembly (§4.3).
 *
 * Built as a factory so tests can inject a fake clock and a shared Prisma
 * client and drive it with `app.inject()` without opening a socket.
 *
 * Route scope: this build covers auth, users, drivers (emergency contact and
 * lookup), bikes (CRUD + pairing), rentals and admin device provisioning. The
 * device gateway (`/d/v1`), incidents, images, notifications, analytics,
 * Socket.IO and the workers are deliberately absent rather than stubbed.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import { PrismaClient } from '@prisma/client';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { Config } from './config.js';
import { systemClock, toIsoRequired, type Clock } from './lib/time.js';
import { maskObject } from './lib/mask.js';
import prismaPlugin from './plugins/prisma.js';
import errorsPlugin from './plugins/errors.js';
import authPlugin from './plugins/auth.js';
import rateLimitPlugin from './plugins/rateLimit.js';
import { registerAuthRoutes } from './modules/auth/routes.js';
import { registerUserRoutes } from './modules/users/routes.js';
import { registerDriverRoutes } from './modules/drivers/routes.js';
import { registerBikeRoutes } from './modules/bikes/routes.js';
import { registerRentalRoutes } from './modules/rentals/routes.js';
import { registerAdminRoutes } from './modules/admin/routes.js';

export interface AppDeps {
  config: Config;
  clock: Clock;
}

export interface BuildAppOptions {
  config: Config;
  /** Tests pass a FakeClock so deadline behaviour is deterministic (§4.3). */
  clock?: Clock;
  prisma?: PrismaClient;
}

export const buildApp = async (options: BuildAppOptions): Promise<FastifyInstance> => {
  const { config } = options;
  const clock = options.clock ?? systemClock;
  const isTest = config.NODE_ENV === 'test';

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
  // Disabled under test so fixtures cannot trip the limiter (§5.4.10).
  await app.register(rateLimitPlugin, { enabled: !isTest });

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

  await app.register(
    async (api) => {
      await registerAuthRoutes(api, deps);
      await registerUserRoutes(api, deps);
      await registerDriverRoutes(api, deps);
      await registerBikeRoutes(api, deps);
      await registerRentalRoutes(api, deps);
      await registerAdminRoutes(api, deps);
    },
    { prefix: '/api/v1' },
  );

  await app.ready();
  return app;
};
