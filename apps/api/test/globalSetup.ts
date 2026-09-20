/**
 * Applies the migrations once before the suite runs, so the tests exercise the
 * real schema **including the raw SQL invariants of §5.6.3** - the partial
 * unique indexes are the whole point of the concurrency tests, and `db push`
 * would not create them.
 *
 * Point TEST_DATABASE_URL at a scratch Postgres 16:
 *
 *   docker run -d --name crashlink-test-db -p 55432:5432 \
 *     -e POSTGRES_USER=crashlink -e POSTGRES_PASSWORD=crashlink \
 *     -e POSTGRES_DB=crashlink_test postgres:16-alpine
 *
 * Note this never falls back to DATABASE_URL: the suite truncates every table,
 * so it must not be able to point itself at a dev or production database.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { assertDisposableDatabase, DEFAULT_TEST_DATABASE_URL } from './setup.js';

export default function globalSetup(): void {
  const databaseUrl = process.env['TEST_DATABASE_URL'] ?? DEFAULT_TEST_DATABASE_URL;
  assertDisposableDatabase(databaseUrl);

  process.env['DATABASE_URL'] = databaseUrl;

  execFileSync(
    'npx',
    ['prisma', 'migrate', 'deploy', '--schema', resolve(process.cwd(), 'prisma/schema.prisma')],
    {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'inherit',
      shell: process.platform === 'win32',
    },
  );
}
