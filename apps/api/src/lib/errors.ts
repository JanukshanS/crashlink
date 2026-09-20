/**
 * §5.4.1 error model. Every error leaves the API as
 * `{ code, message, requestId, details }` with a code from the §5.4.1 table.
 */
import { ERROR_STATUS, type ErrorCode } from '@crashlink/contracts';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = ERROR_STATUS[code];
    this.details = details;
  }
}

/**
 * §5.7.2: other owners' ids return 404, never 403, so the API cannot be used to
 * enumerate which ids exist.
 */
export const notFound = (what = 'Resource'): AppError =>
  new AppError('NOT_FOUND', `${what} not found.`);

export const validationFailed = (message: string, details: Record<string, unknown> = {}): AppError =>
  new AppError('VALIDATION_FAILED', message, details);

export const unauthorized = (message = 'Authentication required.'): AppError =>
  new AppError('UNAUTHORIZED', message);

export const forbidden = (message = 'You may not perform this action.'): AppError =>
  new AppError('FORBIDDEN', message);

export const readOnlyGuest = (): AppError =>
  new AppError('READ_ONLY_GUEST', 'The guest account is read-only.');

export const conflict = (code: ErrorCode, message: string, details: Record<string, unknown> = {}) =>
  new AppError(code, message, details);
