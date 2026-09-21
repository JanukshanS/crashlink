/**
 * Deadline worker (§4.3, 1 s) - rule D2.
 *
 * Finds every incident still PENDING whose response window has closed and asks
 * the decision engine to apply TIMEOUT. The engine re-checks under the row lock,
 * so a rider answering in the same instant still wins if they got there first.
 *
 * The scan is served by `incidents_pending_deadline` (§5.6.3), a partial index
 * on exactly this predicate.
 */
import type { WorkerDeps } from './index.js';

/** Bounded so one pass cannot monopolise the pool during a burst. */
const BATCH = 50;

export const runDeadlinePass = async (deps: WorkerDeps): Promise<number> => {
  const now = deps.clock.now();

  const due = await deps.prisma.incident.findMany({
    where: {
      decision: 'PENDING',
      responseDeadlineAt: { lte: now, not: null },
    },
    orderBy: { responseDeadlineAt: 'asc' },
    select: { id: true },
    take: BATCH,
  });

  let timedOut = 0;

  for (const incident of due) {
    const outcome = await deps.decisions.evaluateDeadline(incident.id);
    if (!outcome) continue;

    timedOut += 1;
    deps.log('incident timed out', {
      incidentId: incident.id,
      contactSmsRequested: outcome.contactSmsCreated,
    });
  }

  return timedOut;
};
