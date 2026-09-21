/**
 * `npm run demo:check` - the pre-demo checklist, printed green / yellow / red.
 *
 *   API health · database + migrations · worker lag · devices online ·
 *   pending commands · TLS certificate expiry · demo data seeded
 *
 * Exits 1 if anything is red, so it can gate a script. Rules live in
 * src/demo/checkRules.ts and are unit-tested; this file only gathers facts.
 *
 *   npm run demo:check                      API at http://127.0.0.1:$PORT
 *   npm run demo:check -- --api https://crashlink.example.com
 */
import { readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect as tlsConnect } from 'node:tls';
import { PrismaClient } from '@prisma/client';
import { OPEN_INCIDENT_STATES } from '@crashlink/contracts';
import { loadConfig, type Config } from '../config.js';
import { deviceOnlineState } from '../modules/bikes/service.js';
import { DEMO_ACCOUNTS } from '../demo/seedDemo.js';
import {
  classifyCert,
  classifyCommands,
  classifyDevice,
  classifyWorker,
  summarize,
  type CertFact,
  type CheckResult,
} from '../demo/checkRules.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(HERE, '../../prisma/migrations');

const color = process.env['NO_COLOR'] ? null : { green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', dim: '\x1b[2m', reset: '\x1b[0m' };
const paint = (text: string, tone: 'green' | 'yellow' | 'red' | 'dim'): string =>
  color ? `${color[tone]}${text}${color.reset}` : text;
const ICON = { green: '✓', yellow: '!', red: '✗' } as const;

const argValue = (flag: string): string | undefined => {
  const index = process.argv.indexOf(flag);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
};

const fetchJson = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
  const body = (await response.json()) as T;
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(body).slice(0, 120)}`);
  return body;
};

const readCert = (baseUrl: string): Promise<CertFact> => {
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:') return Promise.resolve({ kind: 'not-https', url: baseUrl });

  return new Promise((resolvePromise) => {
    const socket = tlsConnect(
      { host: url.hostname, port: Number(url.port || 443), servername: url.hostname, timeout: 5000 },
      () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        resolvePromise(
          cert?.valid_to
            ? { kind: 'ok', host: url.hostname, validTo: new Date(cert.valid_to) }
            : { kind: 'error', host: url.hostname, message: 'no certificate presented' },
        );
      },
    );
    socket.on('error', (error) => resolvePromise({ kind: 'error', host: url.hostname, message: error.message }));
    socket.on('timeout', () => {
      socket.destroy();
      resolvePromise({ kind: 'error', host: url.hostname, message: 'timed out' });
    });
  });
};

const gather = async (config: Config, prisma: PrismaClient, apiUrl: string): Promise<CheckResult[]> => {
  const checks: CheckResult[] = [];

  // --- 1. API health ---------------------------------------------------------
  let serverNow = new Date();
  try {
    const health = await fetchJson<{ status: string; db: string; time: string }>(`${apiUrl}/health`);
    serverNow = new Date(health.time);
    checks.push(
      health.status === 'ok' && health.db === 'ok'
        ? { name: 'API health', status: 'green', detail: `${apiUrl} ok` }
        : { name: 'API health', status: 'red', detail: `status=${health.status} db=${health.db}` },
    );
  } catch (error) {
    checks.push({ name: 'API health', status: 'red', detail: `${apiUrl} unreachable: ${(error as Error).message}` });
  }

  // --- 2. Database + migrations ---------------------------------------------
  try {
    await prisma.$queryRaw`SELECT 1`;
    const applied = await prisma.$queryRaw<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }[]>`
      SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations
    `;
    const done = new Set(applied.filter((row) => row.finished_at && !row.rolled_back_at).map((row) => row.migration_name));
    const failed = applied.filter((row) => !row.finished_at && !row.rolled_back_at);
    const onDisk = readdirSync(MIGRATIONS_DIR).filter((entry) => statSync(resolve(MIGRATIONS_DIR, entry)).isDirectory());
    const pending = onDisk.filter((name) => !done.has(name));

    if (failed.length > 0) {
      checks.push({ name: 'database', status: 'red', detail: `failed migration: ${failed[0]!.migration_name}` });
    } else if (pending.length > 0) {
      checks.push({ name: 'database', status: 'red', detail: `${pending.length} pending migration(s) - run db:deploy` });
    } else {
      checks.push({ name: 'database', status: 'green', detail: `connected, ${done.size} migrations applied` });
    }
  } catch (error) {
    checks.push({ name: 'database', status: 'red', detail: `cannot connect: ${(error as Error).message.split('\n')[0]}` });
  }

  // --- 3. Workers (via /admin/health) -------------------------------------
  try {
    if (!config.ADMIN_SEED_PASSWORD) throw new Error('ADMIN_SEED_PASSWORD is not set, cannot sign in as admin');
    const session = await fetchJson<{ accessToken: string }>(`${apiUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: DEMO_ACCOUNTS.admin, password: config.ADMIN_SEED_PASSWORD }),
    });
    const health = await fetchJson<{
      workers: Record<string, { lastRunAt: string | null; intervalMs: number; lastError: string | null }>;
    }>(`${apiUrl}/api/v1/admin/health`, { headers: { authorization: `Bearer ${session.accessToken}` } });

    for (const [name, worker] of Object.entries(health.workers)) {
      checks.push(classifyWorker({ name, ...worker }, serverNow));
    }
  } catch (error) {
    checks.push({ name: 'workers', status: 'red', detail: `could not read /admin/health: ${(error as Error).message}` });
  }

  // --- 4. Devices online -----------------------------------------------------
  try {
    const bikes = await prisma.bike.findMany({
      where: { deviceId: { not: null }, isDemo: true },
      include: { device: true },
      orderBy: { label: 'asc' },
    });
    if (bikes.length === 0) {
      checks.push({ name: 'devices', status: 'red', detail: 'no demo bike has a paired device - run demo:reset' });
    }
    for (const bike of bikes) {
      if (!bike.device) continue;
      const device = bike.device;
      checks.push(
        classifyDevice(
          {
            code: device.code,
            bikeLabel: bike.label,
            online: deviceOnlineState(device.lastSeenAt, bike.ignition === 'ON', device.config, serverNow),
            lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
            simulator: Boolean((device.config as { demoMode?: boolean } | null)?.demoMode),
            revoked: device.revokedAt !== null,
          },
          serverNow,
        ),
      );
    }
  } catch (error) {
    checks.push({ name: 'devices', status: 'red', detail: (error as Error).message });
  }

  // --- 5. Pending commands --------------------------------------------------
  try {
    const commands = await prisma.deviceCommand.findMany({
      where: { status: { in: ['QUEUED', 'DELIVERED'] }, expiresAt: { gt: serverNow } },
      include: { device: { select: { code: true } } },
    });
    checks.push(
      classifyCommands(
        commands.map((command) => ({
          deviceCode: command.device.code,
          type: command.type,
          ageSec: (serverNow.getTime() - command.createdAt.getTime()) / 1000,
        })),
      ),
    );
  } catch (error) {
    checks.push({ name: 'pending device commands', status: 'red', detail: (error as Error).message });
  }

  // --- 6. TLS certificate ----------------------------------------------------
  checks.push(classifyCert(await readCert(config.PUBLIC_BASE_URL), new Date()));

  // --- 7. Demo data ----------------------------------------------------------
  try {
    const accounts = await prisma.user.findMany({
      where: { email: { in: Object.values(DEMO_ACCOUNTS) } },
      select: { email: true },
    });
    const missing = Object.values(DEMO_ACCOUNTS).filter((email) => !accounts.some((a) => a.email === email));
    checks.push(
      missing.length === 0
        ? { name: 'demo accounts', status: 'green', detail: 'admin, owner, driver and judge accounts present' }
        : { name: 'demo accounts', status: 'red', detail: `missing ${missing.join(', ')} - run demo:reset` },
    );

    // Leftovers from a rehearsal make the first screen the judges see wrong.
    const [openIncidents, openRentals] = await Promise.all([
      prisma.incident.count({ where: { isDemo: true, state: { in: [...OPEN_INCIDENT_STATES] } } }),
      prisma.rental.count({
        where: { bike: { isDemo: true }, state: { in: ['PENDING_SYNC', 'ACTIVE', 'ENDING_SYNC'] } },
      }),
    ]);
    checks.push(
      openIncidents + openRentals === 0
        ? { name: 'rehearsal leftovers', status: 'green', detail: 'no open demo incidents or rentals' }
        : {
            name: 'rehearsal leftovers',
            status: 'yellow',
            detail: `${openIncidents} open incident(s), ${openRentals} open rental(s) - run demo:reset for a clean start`,
          },
    );

    checks.push(
      config.GUEST_ENABLED
        ? { name: 'judge login', status: 'green', detail: 'GUEST_ENABLED=true ("Continue as Judge" works)' }
        : { name: 'judge login', status: 'yellow', detail: 'GUEST_ENABLED=false - "Continue as Judge" will fail' },
    );
  } catch (error) {
    checks.push({ name: 'demo data', status: 'red', detail: (error as Error).message });
  }

  return checks;
};

const main = async (): Promise<void> => {
  const config = loadConfig();
  const apiUrl = (argValue('--api') ?? `http://127.0.0.1:${config.PORT}`).replace(/\/$/, '');
  const prisma = new PrismaClient();

  try {
    const checks = await gather(config, prisma, apiUrl);
    const summary = summarize(checks);
    const width = Math.max(...checks.map((check) => check.name.length));

    /* eslint-disable no-console */
    console.log('');
    console.log('  CrashLink pre-demo check');
    console.log(paint('  ----------------------------------------------------------------', 'dim'));
    for (const check of checks) {
      console.log(`  ${paint(ICON[check.status], check.status)} ${check.name.padEnd(width)}  ${paint(check.detail, check.status === 'green' ? 'dim' : check.status)}`);
    }
    console.log(paint('  ----------------------------------------------------------------', 'dim'));
    const line = `${summary.green} ok · ${summary.yellow} warning(s) · ${summary.red} failing`;
    console.log(summary.ready ? `  ${paint('READY', 'green')}      ${line}` : `  ${paint('NOT READY', 'red')}  ${line}`);
    console.log('');
    /* eslint-enable no-console */

    process.exitCode = summary.ready ? 0 : 1;
  } finally {
    await prisma.$disconnect();
  }
};

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('demo:check failed:', error);
  process.exitCode = 1;
});
