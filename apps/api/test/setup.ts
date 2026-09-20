/**
 * Test environment: deterministic secrets and a database URL for every worker.
 *
 * The tests TRUNCATE every table between cases, so this deliberately does NOT
 * fall back to `DATABASE_URL`. If it did, running `npm test` with a dev (or
 * worse, production) `DATABASE_URL` exported would wipe that database. Point
 * `TEST_DATABASE_URL` at a scratch database, or accept the local default.
 */
export const DEFAULT_TEST_DATABASE_URL =
  'postgresql://crashlink:crashlink@localhost:55432/crashlink_test';

/**
 * A second belt: refuse to run against a database whose name does not look
 * disposable. Cheap, and the failure mode it prevents is unrecoverable.
 */
export const assertDisposableDatabase = (url: string): void => {
  let name: string;
  try {
    name = new URL(url).pathname.replace(/^\//, '');
  } catch {
    throw new Error(`TEST_DATABASE_URL is not a valid URL: ${url}`);
  }

  if (!/test/i.test(name)) {
    throw new Error(
      `Refusing to run tests against database "${name}": the suite TRUNCATEs every table.\n` +
        'Use a database with "test" in its name (e.g. crashlink_test) via TEST_DATABASE_URL.',
    );
  }
};

const databaseUrl = process.env['TEST_DATABASE_URL'] ?? DEFAULT_TEST_DATABASE_URL;
assertDisposableDatabase(databaseUrl);

process.env['NODE_ENV'] = 'test';
process.env['DATABASE_URL'] = databaseUrl;

// Fixed, obviously-fake values: nothing here is a real secret (§5.7.3).
process.env['JWT_SECRET'] ??= 'test-jwt-secret-that-is-long-enough-0123456789';
process.env['DEVICE_SECRET_KEY'] ??= '0'.repeat(64);
process.env['FILE_URL_SECRET'] ??= 'test-file-url-secret';
process.env['ADMIN_SEED_PASSWORD'] ??= 'test-admin-password';
process.env['DEMO_MODE'] ??= 'true';
process.env['GUEST_ENABLED'] ??= 'true';
