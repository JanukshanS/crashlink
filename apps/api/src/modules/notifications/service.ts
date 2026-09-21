/**
 * FR-NOT-01/02 - logical notifications and their append-only attempts.
 *
 * The honesty rule (NFR-04) lives here: a logical notification records what we
 * *asked* for, and each attempt records what the modem actually reported. The
 * UI may only say "delivered" for `NETWORK_CONFIRMED` (a real `+CDS` delivery
 * report) or `CLIENT_RECEIVED` (the app acked). `AT_SUBMITTED` means the modem
 * accepted the message - not that anyone received it.
 */
import type { Prisma } from '@prisma/client';
import type { NotificationKind, NotificationState } from '@crashlink/contracts';
import { maskPhone } from '../../lib/mask.js';

/** States that may never be walked back once reached (append-only history). */
const STATE_RANK: Record<NotificationState, number> = {
  REQUESTED: 0,
  QUEUED: 1,
  PROVIDER_ACCEPTED: 2,
  CLIENT_RECEIVED: 3,
  AT_SUBMITTED: 3,
  OUTCOME_UNKNOWN: 4,
  FAILED: 4,
  NETWORK_CONFIRMED: 5,
  RESPONDED: 6,
};

export const isStrongerState = (next: NotificationState, current: NotificationState): boolean =>
  STATE_RANK[next] > STATE_RANK[current];

/**
 * Creates the logical notification if it does not exist yet. Unique per
 * `(incidentId, kind)` (§5.6.4), so this is safe to call from any path - the
 * decision engine calls it inside its transaction.
 */
export const ensureNotification = async (
  tx: Prisma.TransactionClient,
  input: {
    incidentId: string;
    kind: NotificationKind;
    recipientPhone?: string | null;
    state?: NotificationState;
    at: Date;
  },
): Promise<{ id: string; created: boolean }> => {
  const existing = await tx.notification.findUnique({
    where: { incidentId_kind: { incidentId: input.incidentId, kind: input.kind } },
    select: { id: true },
  });

  if (existing) return { id: existing.id, created: false };

  const created = await tx.notification.create({
    data: {
      incidentId: input.incidentId,
      kind: input.kind,
      state: input.state ?? 'REQUESTED',
      // §5.7.3: only the masked form is stored on the notification; the full
      // number lives on the rental/incident snapshot.
      recipientMasked: maskPhone(input.recipientPhone ?? null),
      requestedAt: input.at,
    },
    select: { id: true },
  });

  return { id: created.id, created: true };
};

/**
 * §5.3.7 - records one physical attempt. Idempotent on
 * `(notificationId, attemptNo, state)`, because the device retries reporting
 * and must never inflate the attempt history.
 *
 * The logical state only ever moves forward: a late `QUEUED` report arriving
 * after `NETWORK_CONFIRMED` must not downgrade what we know.
 */
export const recordAttempt = async (
  tx: Prisma.TransactionClient,
  input: {
    notificationId: string;
    attemptNo: number;
    state: NotificationState;
    detail?: string | null;
    deviceTime?: Date | null;
  },
): Promise<{ recorded: boolean; state: NotificationState }> => {
  const existing = await tx.notificationAttempt.findUnique({
    where: {
      notificationId_attemptNo_state: {
        notificationId: input.notificationId,
        attemptNo: input.attemptNo,
        state: input.state,
      },
    },
    select: { id: true },
  });

  if (!existing) {
    await tx.notificationAttempt.create({
      data: {
        notificationId: input.notificationId,
        attemptNo: input.attemptNo,
        state: input.state,
        detail: input.detail ?? null,
        deviceTime: input.deviceTime ?? null,
      },
    });
  }

  const notification = await tx.notification.findUniqueOrThrow({
    where: { id: input.notificationId },
    select: { state: true },
  });

  if (isStrongerState(input.state, notification.state)) {
    await tx.notification.update({
      where: { id: input.notificationId },
      data: { state: input.state },
    });
    return { recorded: !existing, state: input.state };
  }

  return { recorded: !existing, state: notification.state };
};

/** Moves a logical notification forward, never backward. */
export const advanceNotification = async (
  tx: Prisma.TransactionClient,
  input: { incidentId: string; kind: NotificationKind; state: NotificationState },
): Promise<void> => {
  const notification = await tx.notification.findUnique({
    where: { incidentId_kind: { incidentId: input.incidentId, kind: input.kind } },
    select: { id: true, state: true },
  });

  if (!notification) return;
  if (!isStrongerState(input.state, notification.state)) return;

  await tx.notification.update({ where: { id: notification.id }, data: { state: input.state } });
};
