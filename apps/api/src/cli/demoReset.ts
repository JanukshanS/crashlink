/**
 * `npm run demo:reset` (FR-DEMO-03): clear demo incidents, rentals and traces,
 * then re-seed the baseline demo. Real owners' data is never touched, and
 * device secrets are kept so the bikes keep working.
 *
 *   npm run demo:reset            refuses unless DEMO_MODE=true
 *   npm run demo:reset -- --force run anyway (it still only touches demo data)
 */
import { PrismaClient } from '@prisma/client';
import { loadConfig } from '../config.js';
import { systemClock } from '../lib/time.js';
import { DemoResetRefused, resetDemoData } from '../demo/demoReset.js';

const main = async (): Promise<void> => {
  const force = process.argv.includes('--force');
  const prisma = new PrismaClient();

  try {
    const result = await resetDemoData(prisma, loadConfig(), systemClock, { force });

    /* eslint-disable no-console */
    console.log('');
    console.log('  \x1b[32m✓ Demo reset complete\x1b[0m');
    console.log('  ----------------------------------------------------------------');
    console.log(`  cleared   ${result.incidents} incidents, ${result.rentals} rentals, ${result.photos} photos`);
    console.log(`            ${result.locations} location samples, ${result.ignitionEvents} ignition events`);
    console.log(`            ${result.commands} queued device commands`);
    console.log(`  re-seeded ${result.seed.incidents} demo history incidents on ${result.seed.bikeIds.length} bikes`);
    console.log('  devices   credentials unchanged - no re-flash needed');
    console.log('');
    console.log('  Next: npm run demo:check');
    console.log('');
    /* eslint-enable no-console */
  } catch (error) {
    if (error instanceof DemoResetRefused) {
      // eslint-disable-next-line no-console
      console.error(`\n  \x1b[31m✗ ${error.message}\x1b[0m\n`);
      process.exitCode = 2;
      return;
    }
    throw error;
  } finally {
    await prisma.$disconnect();
  }
};

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('demo:reset failed:', error);
  process.exitCode = 1;
});
