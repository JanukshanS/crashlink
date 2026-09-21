/**
 * Retention worker (§4.3 daily, §5.6.6, NFR-06).
 *
 * Locations 30 d, images 90 d, audit 180 d, temp upload parts 24 h - all
 * configurable. Incidents themselves are kept (365 d per §5.6.6) and are not
 * deleted here: an incident record is the evidence of what the system did.
 */
import { readdir, stat, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { WorkerDeps } from './index.js';

const daysAgo = (now: Date, days: number): Date =>
  new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

export const runRetentionPass = async (deps: WorkerDeps): Promise<number> => {
  const now = deps.clock.now();
  let removed = 0;

  // --- location samples ----------------------------------------------------
  const locations = await deps.prisma.locationSample.deleteMany({
    where: { fixAt: { lt: daysAgo(now, deps.config.RETENTION_LOCATIONS_DAYS) } },
  });
  removed += locations.count;

  // --- audit events --------------------------------------------------------
  const audit = await deps.prisma.auditEvent.deleteMany({
    where: { createdAt: { lt: daysAgo(now, deps.config.RETENTION_AUDIT_DAYS) } },
  });
  removed += audit.count;

  // --- images --------------------------------------------------------------
  const imageCutoff = daysAgo(now, deps.config.RETENTION_IMAGES_DAYS);
  const expired = await deps.prisma.incidentImage.findMany({
    where: { completedAt: { lt: imageCutoff }, storageKey: { not: null } },
    select: { id: true, storageKey: true, incidentId: true },
  });

  for (const image of expired) {
    if (image.storageKey) {
      const path = resolve(deps.config.IMAGE_DIR, image.storageKey);
      await unlink(path).catch(() => undefined);
    }
    // The incident keeps photoStatus AVAILABLE: a photo *was* captured and
    // verified. With the image row gone the detail view reports it as
    // `expired`, which is true - "not requested" would not be.
    await deps.prisma.incidentImage.delete({ where: { id: image.id } });
    removed += 1;
  }

  // --- abandoned temp parts (§5.6.6: 24 h) ---------------------------------
  const tmpDir = resolve(deps.config.IMAGE_DIR, 'tmp');
  if (existsSync(tmpDir)) {
    const cutoff = now.getTime() - 24 * 60 * 60 * 1000;
    const entries = await readdir(tmpDir).catch(() => [] as string[]);

    for (const entry of entries) {
      const path = join(tmpDir, entry);
      const info = await stat(path).catch(() => null);
      if (info && info.mtimeMs < cutoff) {
        await unlink(path).catch(() => undefined);
        removed += 1;
      }
    }
  }

  if (removed > 0) deps.log('retention pass removed records', { removed });
  return removed;
};
