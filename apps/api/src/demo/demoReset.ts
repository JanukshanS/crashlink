/**
 * FR-DEMO-03 - demo reset: "clears incidents/rentals of demo data only", then
 * re-seeds the baseline demo (§5.6.7).
 *
 * "Demo data" is anything owned by a demo owner, on a demo bike, or flagged
 * `isDemo` (which includes every simulated event, wherever it landed). Real
 * owners' records are never touched - that is the whole contract of this
 * function, and it is tested.
 *
 * Device secrets are not rotated: the bikes keep working through a reset.
 */
import { unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import type { Config } from '../config.js';
import type { Clock } from '../lib/time.js';
import { seedDemo, type SeedResult } from './seedDemo.js';

export interface DemoResetResult {
  incidents: number;
  rentals: number;
  locations: number;
  ignitionEvents: number;
  commands: number;
  photos: number;
  seed: SeedResult;
}

export class DemoResetRefused extends Error {}

export const resetDemoData = async (
  prisma: PrismaClient,
  config: Config,
  clock: Clock,
  options: { force?: boolean; writeSecretsHeader?: boolean } = {},
): Promise<DemoResetResult> => {
  // §5.4.8 lists demo reset as ADMIN + DEMO_MODE. Wiping incidents on a
  // production server by accident would destroy evidence, so it is refused
  // unless the server is in demo mode or the operator insists.
  if (!config.DEMO_MODE && !options.force) {
    throw new DemoResetRefused('DEMO_MODE is not enabled. Refusing to reset (pass --force to override).');
  }

  const demoOwners = await prisma.user.findMany({
    where: { role: 'OWNER', isDemo: true },
    select: { id: true },
  });
  const ownerIds = demoOwners.map((owner) => owner.id);

  const demoBikes = await prisma.bike.findMany({
    where: { OR: [{ isDemo: true }, { ownerId: { in: ownerIds } }] },
    select: { id: true, deviceId: true },
  });
  const bikeIds = demoBikes.map((bike) => bike.id);
  const deviceIds = demoBikes.map((bike) => bike.deviceId).filter((id): id is string => id !== null);

  const incidentWhere = {
    OR: [{ isDemo: true }, { ownerId: { in: ownerIds } }, { bikeId: { in: bikeIds } }],
  };

  // Photo files first: the rows cascade away with their incidents, the files
  // would not.
  const images = await prisma.incidentImage.findMany({
    where: { incident: incidentWhere, storageKey: { not: null } },
    select: { storageKey: true },
  });
  let photos = 0;
  for (const image of images) {
    if (!image.storageKey) continue;
    await unlink(resolve(config.IMAGE_DIR, image.storageKey)).then(
      () => (photos += 1),
      () => undefined,
    );
  }

  const incidents = await prisma.incident.deleteMany({ where: incidentWhere });
  const rentals = await prisma.rental.deleteMany({
    where: { OR: [{ ownerId: { in: ownerIds } }, { bikeId: { in: bikeIds } }] },
  });
  const locations = await prisma.locationSample.deleteMany({ where: { bikeId: { in: bikeIds } } });
  const ignitionEvents = await prisma.ignitionEvent.deleteMany({ where: { bikeId: { in: bikeIds } } });
  const commands = await prisma.deviceCommand.deleteMany({ where: { deviceId: { in: deviceIds } } });
  await prisma.bike.updateMany({ where: { id: { in: bikeIds } }, data: { status: 'AVAILABLE' } });

  const seed = await seedDemo(prisma, config, {
    rotateDeviceSecrets: false,
    writeSecretsHeader: options.writeSecretsHeader ?? false,
  });

  // §5.7.3: "demo reset" is one of the audited actions.
  await prisma.auditEvent.create({
    data: {
      actorType: 'SYSTEM',
      action: 'DEMO_RESET',
      meta: {
        incidents: incidents.count,
        rentals: rentals.count,
        locations: locations.count,
        commands: commands.count,
        photos,
      },
      createdAt: clock.now(),
    },
  });

  return {
    incidents: incidents.count,
    rentals: rentals.count,
    locations: locations.count,
    ignitionEvents: ignitionEvents.count,
    commands: commands.count,
    photos,
    seed,
  };
};
