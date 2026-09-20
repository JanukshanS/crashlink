/**
 * §5.4.10 rate limits. The global limit is the "App API general" row
 * (120/min per user); the tighter per-route limits (login 10/min, pairing
 * 5/min) are set on the routes themselves via `config.rateLimit`.
 */
import fp from 'fastify-plugin';
import fastifyRateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/** §5.4.10 "App API general": 120/min per user. */
export const APP_API_RATE_LIMIT_PER_MIN = 120;

export interface RateLimitPluginOptions {
  /** Disabled in tests so fixtures do not trip the limiter. */
  enabled: boolean;
}

export default fp<RateLimitPluginOptions>(
  async (app: FastifyInstance, options: RateLimitPluginOptions) => {
    await app.register(fastifyRateLimit, {
      global: options.enabled,
      max: APP_API_RATE_LIMIT_PER_MIN,
      timeWindow: '1 minute',
      // Per user once authenticated (the token is decoded in an onRequest hook
      // registered before this one), per IP otherwise.
      keyGenerator: (request: FastifyRequest) => request.authUser?.id ?? request.ip,
      // The plugin throws whatever this returns. Handing back an Error with a
      // status code routes it through plugins/errors.ts, so a 429 gets the same
      // §5.4.1 body as every other failure.
      errorResponseBuilder: () => {
        const error = new Error('Too many requests. Please slow down.') as Error & {
          statusCode: number;
        };
        error.statusCode = 429;
        return error;
      },
    });
  },
  { name: 'rateLimit' },
);
