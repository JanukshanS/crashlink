/**
 * `npm run db:seed -w apps/api [-- --rotate-device-secrets]` (§5.6.7).
 *
 * Device secrets are **kept** unless --rotate-device-secrets is passed: the
 * real bike holds its secret in firmware, and a routine re-seed must not lock
 * it out. New secrets are printed once and cannot be read back.
 */
import { PrismaClient } from '@prisma/client';
import { loadConfig } from '../src/config.js';
import { DEMO_ACCOUNTS, DEMO_PEOPLE, seedDemo } from '../src/demo/seedDemo.js';

const main = async (): Promise<void> => {
  const rotate = process.argv.includes('--rotate-device-secrets');
  const prisma = new PrismaClient();

  try {
    const result = await seedDemo(prisma, loadConfig(), { rotateDeviceSecrets: rotate });

    /* eslint-disable no-console */
    console.log('');
    console.log('  CrashLink seed complete');
    console.log('  ----------------------------------------------------------------');
    console.log(`  admin    ${DEMO_ACCOUNTS.admin} / ADMIN_SEED_PASSWORD`);
    console.log(`  owner    ${DEMO_ACCOUNTS.owner} / demo1234   (${DEMO_PEOPLE.owner})`);
    console.log(`  driver   ${DEMO_ACCOUNTS.driver} / demo1234   (${DEMO_PEOPLE.driver})`);
    console.log(`  guest    ${DEMO_ACCOUNTS.guest} / demo1234   (read-only)`);
    console.log(`  history  ${result.incidents} demo incidents`);
    console.log('');
    for (const device of result.devices) {
      if (device.credentials) {
        console.log(`  ${device.code}  NEW credentials - shown ONCE, not recoverable:`);
        console.log(`    secret=${device.credentials.secret}`);
        console.log(`    pairingCode=${device.credentials.pairingCode}  apPassword=${device.credentials.apPassword}`);
      } else {
        console.log(`  ${device.code}  credentials unchanged (use --rotate-device-secrets to issue new ones)`);
      }
    }
    if (result.secretsPath) console.log(`\n  Wrote ${result.secretsPath} (gitignored). Re-flash CL-0001.`);
    console.log('');
    console.log('  NOTE (§5.6.7): replace the demo phone numbers with real team');
    console.log('  numbers before the live demo - the bike actually texts them.');
    console.log('');
    /* eslint-enable no-console */
  } finally {
    await prisma.$disconnect();
  }
};

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('Seed failed:', error);
  process.exitCode = 1;
});
