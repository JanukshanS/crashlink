/**
 * CrashLink device simulator (FR-DEMO-02).
 *
 * Speaks the real device protocol: HMAC-signed requests in the Appendix E.1.2
 * query-string form, the §4.5.1 state machine with 3 s control polling, and
 * 2 KB chunked image upload. If this passes and the firmware does not, the
 * difference is in the firmware - which is the point.
 *
 *   npm run sim -w tools/device-sim -- vector --secret <hex>
 *   npm run sim -w tools/device-sim -- collision-timeout --device CL-0002
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { DeviceClient, buildCanonicalString, sign } from './client.js';
import { DEFAULT_MACHINE_CONFIG, DeviceMachine, type MachineConfig } from './machine.js';
import { SCENARIOS, runScenario, type ScenarioName } from './scenarios.js';
import { clearState, loadState, saveState } from './nvs.js';

const HERE = dirname(fileURLToPath(import.meta.url));

interface Args {
  command: string;
  device?: string;
  secret?: string;
  url: string;
  timeScale: number;
  image: string;
  verbose: boolean;
  /** Wipes the NVS stand-in first, simulating a factory-reset device. */
  forget: boolean;
  // `vector` only
  method: string;
  path: string;
  ts?: number;
  nonce: string;
  body: string;
}

const usage = (): string =>
  [
    'CrashLink device simulator',
    '',
    'Usage:',
    '  npm run sim -w tools/device-sim -- <command> [options]',
    '',
    'Commands:',
    '  vector              Print the canonical string + expected signature (for firmware devs)',
    ...Object.entries(SCENARIOS).map(([name, description]) => `  ${name.padEnd(19)} ${description}`),
    '',
    'Options:',
    '  --device CL-0001    Device code (or CL_DEVICE_CODE)',
    '  --secret <64 hex>   Device secret  (or CL_DEVICE_SECRET)',
    '  --url  <base>       API base URL   (default http://127.0.0.1:3000, or CL_API_URL)',
    '  --time-scale 1      Multiply every wait (0.1 = ten times faster, for tests)',
    '  --image <path>      JPEG to upload (default ./fixtures/demo.jpg)',
    '  --verbose           Log every request',
    '  --forget            Clear the simulated NVS before running',
    '',
    'vector options:',
    '  --method POST --path /d/v1/heartbeat --ts <unix> --nonce <hex> --body <json>',
    '',
    'The secret is printed once by `npm run device:provision -w apps/api`.',
  ].join('\n');

const parseArgs = (argv: string[]): Args => {
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    if (index < 0) return undefined;
    const value = argv[index + 1];
    return value && !value.startsWith('--') ? value : undefined;
  };

  return {
    command: argv[0] ?? '',
    device: flag('device') ?? process.env['CL_DEVICE_CODE'],
    secret: flag('secret') ?? process.env['CL_DEVICE_SECRET'],
    url: flag('url') ?? process.env['CL_API_URL'] ?? 'http://127.0.0.1:3000',
    timeScale: Number(flag('time-scale') ?? '1'),
    image: flag('image') ?? resolve(HERE, '../fixtures/demo.jpg'),
    verbose: argv.includes('--verbose'),
    forget: argv.includes('--forget'),
    method: flag('method') ?? 'POST',
    path: flag('path') ?? '/d/v1/heartbeat',
    ts: flag('ts') ? Number(flag('ts')) : undefined,
    nonce: flag('nonce') ?? 'a91f3c',
    body: flag('body') ?? '',
  };
};

/**
 * The reference vector firmware developers check against before touching the
 * modem (Appendix E.1.2). If the ESP32 produces these exact bytes, signing is
 * correct; if not, nothing else will work.
 */
const printVector = (args: Args): void => {
  if (!args.secret) throw new Error('--secret is required for `vector`');

  const device = args.device ?? 'CL-0001';
  const ts = args.ts ?? 1758380000;
  const body = Buffer.from(args.body, 'utf8');

  const canonical = buildCanonicalString({
    method: args.method,
    path: args.path,
    dev: device,
    ts,
    nonce: args.nonce,
    body,
  });
  const signature = sign(canonical, args.secret);

  console.log('');
  console.log('  Appendix E.1.2 test vector');
  console.log('  ----------------------------------------------------------------');
  console.log(`  method        ${args.method.toUpperCase()}`);
  console.log(`  path          ${args.path}        (query string excluded)`);
  console.log(`  dev           ${device}`);
  console.log(`  ts            ${ts}`);
  console.log(`  nonce         ${args.nonce}`);
  console.log(`  body          ${args.body === '' ? '(empty)' : args.body}`);
  console.log(`  sha256(body)  ${canonical.split('\n')[5]}`);
  console.log('');
  console.log('  canonical string (\\n separated, shown escaped):');
  console.log(`    ${JSON.stringify(canonical)}`);
  console.log('');
  console.log('  canonical string (as bytes):');
  for (const line of canonical.split('\n')) console.log(`    ${line}`);
  console.log('');
  console.log(`  signature     ${signature}`);
  console.log('');
  console.log('  full query:');
  console.log(`    ?dev=${device}&ts=${ts}&nonce=${args.nonce}&sig=${signature}`);
  console.log('');
  console.log('  C (mbedtls) equivalent:');
  console.log('    mbedtls_md_hmac(SHA256, secret_bytes, 32, canonical, len, out);');
  console.log('');
};

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  if (!args.command || args.command === '--help' || args.command === '-h') {
    console.log(usage());
    return;
  }

  if (args.command === 'vector') {
    printVector(args);
    return;
  }

  if (!(args.command in SCENARIOS)) {
    console.error(`Unknown command: ${args.command}\n`);
    console.error(usage());
    process.exitCode = 1;
    return;
  }

  if (!args.device || !args.secret) {
    console.error(
      'Both --device and --secret are required (or CL_DEVICE_CODE / CL_DEVICE_SECRET).\n' +
        'Provision one with: npm run device:provision -w apps/api -- --code CL-0002',
    );
    process.exitCode = 1;
    return;
  }

  const client = new DeviceClient(args.url.replace(/\/$/, ''), {
    code: args.device,
    secret: args.secret,
  }, args.verbose);

  const config: MachineConfig = DEFAULT_MACHINE_CONFIG;
  const log = (message: string): void => console.log(message);

  const runContext = { client, config, log, timeScale: args.timeScale };
  const machine = new DeviceMachine(runContext);

  // §5.3.4: the assignment lives in NVS across reboots, so a scenario run picks
  // up where the last one left off rather than forgetting the rider.
  if (args.forget) clearState(args.device);

  const persisted = loadState(args.device);
  machine.assignment = persisted.assignment;
  machine.configVersion = persisted.configVersion;
  machine.onPersist = (state) => saveState(args.device!, state);

  console.log('');
  console.log(`  ${args.device} -> ${args.url}`);
  console.log(`  scenario: ${args.command} (time scale ${args.timeScale})`);
  if (machine.assignment) {
    console.log(
      `  NVS: assignment v${machine.assignment.assignmentVersion} ` +
        `(rider ${machine.assignment.driverName})`,
    );
  }
  console.log('  ----------------------------------------------------------------');

  await runScenario(args.command as ScenarioName, {
    ...runContext,
    machine,
    imagePath: args.image,
  });

  console.log('  ----------------------------------------------------------------');
  console.log(`  done (device state: ${machine.state})`);
  console.log('');
};

main().catch((error: unknown) => {
  console.error(`\nsimulator failed: ${(error as Error).message}\n`);
  process.exitCode = 1;
});
