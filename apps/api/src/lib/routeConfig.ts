/**
 * §5.4.10 per-route rate limits.
 *
 * The explicit return type matters: passing a bare `{}` or `{ rateLimit: ... }`
 * inline lets Fastify infer its `ContextConfig` generic from that literal, and
 * the two branches then stop being assignable to each other.
 */
export interface RouteRateLimitConfig {
  rateLimit?: { max: number; timeWindow: string };
}

export const routeRateLimit = (
  enabled: boolean,
  max: number,
  timeWindow = '1 minute',
): RouteRateLimitConfig => (enabled ? { rateLimit: { max, timeWindow } } : {});
