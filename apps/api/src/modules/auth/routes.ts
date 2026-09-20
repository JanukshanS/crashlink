/**
 * §5.4.2 Auth routes.
 *
 * `POST /auth/password/forgot` and `/auth/password/reset` are in §5.4.2 but are
 * **not implemented**: M11 removed password reset from the MVP. Admin creates
 * accounts and the seed supplies demo logins. They are not stubbed, so a caller
 * gets an honest 404 rather than a route that pretends to send a code.
 */
import type { FastifyInstance } from 'fastify';
import {
  GuestLoginRequestSchema,
  LoginRequestSchema,
  LogoutRequestSchema,
  RefreshRequestSchema,
  RegisterRequestSchema,
} from '@crashlink/contracts';
import { routeRateLimit } from '../../lib/routeConfig.js';
import { AuthService } from './service.js';
import type { AppDeps } from '../../app.js';

export const registerAuthRoutes = async (app: FastifyInstance, deps: AppDeps): Promise<void> => {
  const service = new AuthService({
    prisma: app.prisma,
    app,
    clock: deps.clock,
    refreshTtlDays: deps.config.REFRESH_TOKEN_TTL_DAYS,
    accessTtlSec: deps.config.ACCESS_TOKEN_TTL_SEC,
    guestEnabled: deps.config.GUEST_ENABLED,
  });

  // §5.4.10: 10/min per IP on login and password routes. Off under test.
  const authRateLimit = routeRateLimit(deps.config.NODE_ENV !== 'test', 10);

  app.post('/auth/register', async (request, reply) => {
    const body = RegisterRequestSchema.parse(request.body);
    const session = await service.register(body);
    return reply.status(201).send(session);
  });

  app.post('/auth/login', { config: authRateLimit }, async (request, reply) => {
    const body = LoginRequestSchema.parse(request.body);
    return reply.status(200).send(await service.login(body));
  });

  app.post('/auth/refresh', async (request, reply) => {
    const body = RefreshRequestSchema.parse(request.body);
    const session = await service.refresh(body.refreshToken);
    // §5.4.2 returns tokens only; the user object stays on /me.
    return reply.status(200).send({
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresIn: session.expiresIn,
    });
  });

  app.post('/auth/logout', { preHandler: app.authenticate }, async (request, reply) => {
    const body = LogoutRequestSchema.parse(request.body);
    await service.logout(body.refreshToken, body.pushToken);
    return reply.status(204).send();
  });

  app.post('/auth/guest', async (request, reply) => {
    GuestLoginRequestSchema.parse(request.body ?? {});
    return reply.status(200).send(await service.guestLogin());
  });
};
