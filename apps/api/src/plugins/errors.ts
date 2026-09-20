/**
 * §5.4.1 error handling: every failure leaves as
 * `{ code, message, requestId, details }` with a code from the §5.4.1 table.
 *
 * Unique-index violations raised by the raw SQL invariants in §5.6.3 are
 * translated here so callers see RENTAL_ACTIVE_EXISTS / DRIVER_BUSY rather than
 * a Prisma error string.
 */
import fp from 'fastify-plugin';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../lib/errors.js';
import { maskObject } from '../lib/mask.js';

/**
 * The §5.6.3 invariants, keyed by `<model>:<violated columns>`.
 *
 * Prisma reports a unique violation as the *column list* in `meta.target`
 * (e.g. `["bike_id"]`), not the index name - so the partial indexes
 * `rentals_one_open_per_bike` and `rentals_one_open_per_driver` are recognised
 * by their column plus the model they fired on. Index names are also accepted,
 * in case a future Prisma reports them instead.
 */
const UNIQUE_VIOLATION_CODES: Record<string, { code: 'RENTAL_ACTIVE_EXISTS' | 'DRIVER_BUSY'; message: string }> = {
  'Rental:bike_id': { code: 'RENTAL_ACTIVE_EXISTS', message: 'Bike already has an open rental.' },
  'Rental:driver_id': { code: 'DRIVER_BUSY', message: 'Driver already has an open rental.' },
  // Two assignments racing on the same bike computed the same version.
  'Rental:bike_id,assignment_version': {
    code: 'RENTAL_ACTIVE_EXISTS',
    message: 'Bike already has an open rental.',
  },
  'rentals_one_open_per_bike': { code: 'RENTAL_ACTIVE_EXISTS', message: 'Bike already has an open rental.' },
  'rentals_one_open_per_driver': { code: 'DRIVER_BUSY', message: 'Driver already has an open rental.' },
};

export const translatePrismaError = (error: unknown): AppError | null => {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return null;

  if (error.code === 'P2002') {
    const target = error.meta?.['target'];
    const columns = Array.isArray(target) ? target.map(String) : [String(target ?? '')];
    const modelName = String(error.meta?.['modelName'] ?? '');

    const mapped =
      UNIQUE_VIOLATION_CODES[`${modelName}:${columns.join(',')}`] ??
      columns.map((column) => UNIQUE_VIOLATION_CODES[column]).find(Boolean);

    if (mapped) return new AppError(mapped.code, mapped.message);
    return new AppError('CONFLICT', 'That value is already in use.', { fields: columns });
  }

  // P2025: "record not found" - ownership-scoped updates land here.
  if (error.code === 'P2025') return new AppError('NOT_FOUND', 'Resource not found.');

  // P2003: foreign key violation - the referenced row does not exist.
  if (error.code === 'P2003') return new AppError('VALIDATION_FAILED', 'Referenced record does not exist.');

  return null;
};

export default fp(
  async (app: FastifyInstance) => {
    type HandledError = Error & { statusCode?: number; validation?: unknown; cause?: unknown };

    app.setErrorHandler((error: HandledError, request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id;

      const send = (status: number, code: string, message: string, details: Record<string, unknown> = {}) => {
        if (status >= 500) {
          request.log.error({ err: error, details: maskObject(details) }, message);
        } else {
          request.log.info({ code, details: maskObject(details) }, message);
        }
        return reply.status(status).send({ code, message, requestId, details });
      };

      if (error instanceof AppError) {
        return send(error.statusCode, error.code, error.message, error.details);
      }

      // Body/query validation - both raw zod and fastify-type-provider-zod wrappers.
      const zodError =
        error instanceof ZodError
          ? error
          : (error as { validation?: unknown; cause?: unknown }).cause instanceof ZodError
            ? ((error as { cause: ZodError }).cause)
            : null;

      if (zodError) {
        return send(400, 'VALIDATION_FAILED', 'Request failed validation.', {
          issues: zodError.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        });
      }

      const translated = translatePrismaError(error);
      if (translated) {
        return send(translated.statusCode, translated.code, translated.message, translated.details);
      }

      const statusCode = (error as { statusCode?: number }).statusCode ?? 500;

      if (statusCode === 429) {
        return send(429, 'RATE_LIMITED', 'Too many requests. Please slow down.');
      }
      if (statusCode === 413) {
        return send(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
      }
      if (statusCode === 401) {
        const isExpired = /expired/i.test(error.message ?? '');
        return send(401, isExpired ? 'TOKEN_EXPIRED' : 'UNAUTHORIZED', error.message || 'Unauthorized.');
      }
      if (statusCode === 400) {
        return send(400, 'VALIDATION_FAILED', error.message || 'Request failed validation.');
      }
      if (statusCode > 400 && statusCode < 500) {
        return send(statusCode, statusCode === 403 ? 'FORBIDDEN' : 'CONFLICT', error.message);
      }

      // Never leak an internal message to a client.
      return send(500, 'INTERNAL', 'Something went wrong on our side.');
    });

    app.setNotFoundHandler((request, reply) =>
      reply.status(404).send({
        code: 'NOT_FOUND',
        message: 'Resource not found.',
        requestId: request.id,
        details: {},
      }),
    );
  },
  { name: 'errors' },
);
