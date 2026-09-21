/**
 * Dead-man worker (§4.3, 15 s) - FR-INC-10, and mitigation R7.
 *
 * If the bike is destroyed, unplugged or has its SIM pulled, no SMS will ever
 * come - SMS is device-only. The server noticing the silence is the only thing
 * standing between that and nobody being told, so this raises
 * `DEVICE_OFFLINE_DURING_RENTAL` when an ACTIVE rental's device goes quiet for
 * longer than 90 s (ignition ON) or 300 s (OFF).
 *
 * The incident auto-closes when the device reports again (handled in
 * DeviceIngestService.heartbeat).
 */
import type { WorkerDeps } from './index.js';

export const runDeadManPass = async (deps: WorkerDeps): Promise<number> => {
  const now = deps.clock.now();

  const active = await deps.prisma.rental.findMany({
    where: { state: 'ACTIVE' },
    include: {
      bike: { include: { device: { select: { id: true, lastSeenAt: true } } } },
    },
  });

  let raised = 0;

  for (const rental of active) {
    const device = rental.bike.device;
    if (!device) continue;

    // Silence is measured from the last heartbeat, or from the moment the ride
    // started if the device has never reported at all.
    const lastSeen = device.lastSeenAt ?? rental.startedAt ?? rental.requestedAt;
    const silentSec = (now.getTime() - lastSeen.getTime()) / 1000;

    const threshold =
      rental.bike.ignition === 'ON' ? deps.config.DEADMAN_ON_SEC : deps.config.DEADMAN_OFF_SEC;

    if (silentSec <= threshold) continue;

    const incidentId = await deps.ingest.raiseDeadManIncident({
      bikeId: rental.bikeId,
      ownerId: rental.ownerId,
      deviceId: device.id,
      rentalId: rental.id,
      driverId: rental.driverId,
      isDemo: rental.bike.isDemo,
      silentSince: lastSeen,
    });

    if (incidentId) {
      raised += 1;
      deps.log('device silent during active rental', {
        incidentId,
        bikeId: rental.bikeId,
        silentSec: Math.round(silentSec),
        thresholdSec: threshold,
      });
    }
  }

  return raised;
};
