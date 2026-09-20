/**
 * `npm run device:provision -w apps/api -- --code CL-0001` (FR-DEV-01, CLAUDE.md).
 *
 * Prints the device secret **once**. It cannot be recovered afterwards: the
 * database holds only the AES-GCM ciphertext, and losing it means re-provisioning.
 * The output is shaped to paste straight into `firmware/main-esp32/include/secrets.h`,
 * which is gitignored (§5.6.7, §5.7.3).
 */
import { PrismaClient } from '@prisma/client';
import { loadConfig } from '../config.js';
import { ProvisioningService } from '../modules/admin/provisioning.js';

interface CliArgs {
  code?: string;
  json: boolean;
}

const parseArgs = (argv: string[]): CliArgs => {
  const args: CliArgs = { json: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--code') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('--code requires a value, e.g. --code CL-0001');
      }
      args.code = value;
      i += 1;
    } else if (arg?.startsWith('--code=')) {
      args.code = arg.slice('--code='.length);
    } else if (arg === '--json') {
      args.json = true;
    } else if (arg === '--help' || arg === '-h') {
      // eslint-disable-next-line no-console
      console.log(
        'Usage: npm run device:provision -w apps/api -- [--code CL-0001] [--json]\n\n' +
          '  --code   Device code to create. Defaults to the next free CL-NNNN.\n' +
          '  --json   Print the result as JSON instead of a human-readable block.\n',
      );
      process.exit(0);
    }
  }

  return args;
};

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const prisma = new PrismaClient();

  try {
    const service = new ProvisioningService({ prisma, deviceSecretKey: config.DEVICE_SECRET_KEY });
    const device = await service.provision(args.code);

    if (args.json) {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(device, null, 2));
      return;
    }

    /* eslint-disable no-console */
    console.log('');
    console.log(`  Device provisioned: ${device.code}`);
    console.log('  ----------------------------------------------------------------');
    console.log(`  id            ${device.id}`);
    console.log(`  code          ${device.code}`);
    console.log(`  secret        ${device.secret}`);
    console.log(`  pairingCode   ${device.pairingCode}`);
    console.log(`  cameraSecret  ${device.cameraSecret}`);
    console.log(`  apPassword    ${device.apPassword}`);
    console.log('  ----------------------------------------------------------------');
    console.log('  The secret is shown ONCE. Store it now - it cannot be read back.');
    console.log('');
    console.log('  firmware/main-esp32/include/secrets.h (gitignored):');
    console.log('');
    console.log(`    #define CL_DEVICE_CODE   "${device.code}"`);
    console.log(`    #define CL_DEVICE_SECRET "${device.secret}"`);
    console.log(`    #define CL_CAMERA_SECRET "${device.cameraSecret}"`);
    console.log(`    #define CL_AP_PASSWORD   "${device.apPassword}"`);
    console.log('');
    console.log(`  Give the owner the pairing code ${device.pairingCode} to pair it to a bike.`);
    console.log('');
    /* eslint-enable no-console */
  } finally {
    await prisma.$disconnect();
  }
};

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`device:provision failed: ${(error as Error).message}`);
  process.exitCode = 1;
});
