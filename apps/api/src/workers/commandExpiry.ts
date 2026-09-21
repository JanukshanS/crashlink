/**
 * Command expiry worker (§4.3, 30 s) - §5.3.4 and §5.6.6.
 *
 * Expires commands the device never acked (24 h generally, 1 h for
 * INCIDENT_DECISION) and prunes the nonce table past its 10-minute replay
 * window. A command that has aged out must stop being re-sent: an assignment
 * applied a day late would hand the bike a stale rider's phone number.
 */
import { DEVICE_NONCE_TTL_SEC, RENTAL_END_TIMEOUT_SEC } from '@crashlink/contracts';
import type { WorkerDeps } from './index.js';

export const runCommandExpiryPass = async (deps: WorkerDeps): Promise<number> => {
  const now = deps.clock.now();

  const { count } = await deps.prisma.deviceCommand.updateMany({
    where: {
      status: { in: ['QUEUED', 'DELIVERED'] },
      expiresAt: { lte: now },
    },
    data: { status: 'EXPIRED' },
  });

  if (count > 0) deps.log('expired device commands', { count });

  // §5.6.6: nonces are only needed for the replay window.
  const nonceCutoff = new Date(now.getTime() - DEVICE_NONCE_TTL_SEC * 1000);
  const nonces = await deps.prisma.deviceNonce.deleteMany({
    where: { createdAt: { lt: nonceCutoff } },
  });

  if (nonces.count > 0) deps.log('pruned device nonces', { count: nonces.count });

  // FR-RENT-04: ENDING_SYNC rentals end after 10 minutes, with a warning.
  const ended = await deps.ingest.endStaleRentals(RENTAL_END_TIMEOUT_SEC);
  if (ended > 0) deps.log('ended rentals the bike never confirmed', { count: ended });

  // §5.4.1: idempotency records are kept for 24 h.
  const idempotencyCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  await deps.prisma.idempotencyRecord.deleteMany({
    where: { createdAt: { lt: idempotencyCutoff } },
  });

  return count;
};
