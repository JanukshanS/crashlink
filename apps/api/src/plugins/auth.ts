/**
 * §5.7.1 / §5.7.2 - user authentication and role-based authorization.
 *
 * Access tokens are HS256 JWTs (1 h) with claims `sub`, `role`, `isDemo`.
 *
 * The bearer token is decoded in `onRequest` rather than in a route preHandler,
 * so that the global guest guard - which runs at instance `preHandler`, before
 * any route hook - already knows who is calling. Decoding never rejects a
 * request on its own: a public route with a stale token still works, and
 * `authenticate` raises the stored error for routes that need a user.
 */
import fp from 'fastify-plugin';
import fastifyJwt from '@fastify/jwt';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { Role } from '@crashlink/contracts';
import { AppError, forbidden, readOnlyGuest, unauthorized } from '../lib/errors.js';

export interface AuthUser {
  id: string;
  role: Role;
  isDemo: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: AuthUser;
    authError?: AppError;
  }
  interface FastifyInstance {
    authenticate: preHandlerHookHandler;
    requireRole: (...roles: Role[]) => preHandlerHookHandler;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; role: Role; isDemo: boolean };
    user: { sub: string; role: Role; isDemo: boolean };
  }
}

export interface AuthPluginOptions {
  jwtSecret: string;
  accessTokenTtlSec: number;
}

/** The request user, or a 401 - use inside a handler that ran `authenticate`. */
export const requireUser = (request: FastifyRequest): AuthUser => {
  if (!request.authUser) throw request.authError ?? unauthorized();
  return request.authUser;
};

export default fp<AuthPluginOptions>(
  async (app: FastifyInstance, options: AuthPluginOptions) => {
    await app.register(fastifyJwt, {
      secret: options.jwtSecret,
      sign: { expiresIn: options.accessTokenTtlSec },
    });

    app.addHook('onRequest', async (request: FastifyRequest) => {
      if (!request.headers.authorization) return;
      try {
        const payload = await request.jwtVerify<{ sub: string; role: Role; isDemo: boolean }>();
        request.authUser = { id: payload.sub, role: payload.role, isDemo: payload.isDemo };
      } catch (error) {
        const message = (error as Error).message ?? '';
        request.authError = /expired/i.test(message)
          ? new AppError('TOKEN_EXPIRED', 'Access token has expired.')
          : unauthorized('Invalid or missing access token.');
      }
    });

    // §5.7.2: guests are read-only, enforced globally rather than per route.
    app.addHook('preHandler', async (request: FastifyRequest) => {
      if (request.authUser?.role === 'GUEST' && request.method !== 'GET' && request.method !== 'HEAD') {
        throw readOnlyGuest();
      }
    });

    app.decorate('authenticate', async (request: FastifyRequest, _reply: FastifyReply) => {
      requireUser(request);
    });

    app.decorate(
      'requireRole',
      (...roles: Role[]): preHandlerHookHandler =>
        async (request: FastifyRequest, _reply: FastifyReply) => {
          const user = requireUser(request);
          if (!roles.includes(user.role)) {
            // A guest reaching here is asking for a resource their role does not
            // cover, which is FORBIDDEN. READ_ONLY_GUEST is reserved for the
            // mutation case, and the global guard above has already raised it.
            if (user.role === 'GUEST' && request.method !== 'GET' && request.method !== 'HEAD') {
              throw readOnlyGuest();
            }
            throw forbidden(`This action requires one of: ${roles.join(', ')}.`);
          }
        },
    );
  },
  { name: 'auth' },
);
