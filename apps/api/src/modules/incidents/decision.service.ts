/**
 * §5.3.6 decision engine - rules D1-D10.
 *
 * There are three claimants to a single decision: the driver's app, the bike's
 * own button, and the server's deadline worker. Exactly one may win, and the
 * emergency contact must be texted exactly once.
 *
 * Every rule below is enforced inside ONE Prisma interactive transaction that
 * begins with `SELECT ... FOR UPDATE` on the incident row. That row lock is the
 * serialisation point: concurrent control polls, a late SAFE and the worker all
 * queue behind it, and whoever finds `decision = PENDING` first is the winner.
 * The `@@unique([incidentId, kind])` on notifications is the backstop.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import {
  type Decision,
  type DecisionSource,
  type ResponseChoice,
  type ResponseSource,
  INCIDENT_DECISION_COMMAND_TTL_SEC,
} from '@crashlink/contracts';
import { addSeconds, type Clock } from '../../lib/time.js';
import { ensureNotification } from '../notifications/service.js';
import type { RealtimeEmitter } from '../../lib/realtime.js';
import { toIso, toIsoRequired } from '../../lib/time.js';

/** The locked incident row, as the raw `FOR UPDATE` query returns it. */
interface LockedIncident {
  id: string;
  owner_id: string;
  driver_id: string | null;
  bike_id: string;
  device_id: string | null;
  decision: Decision;
  state: string;
  type: string;
  response_deadline_at: Date | null;
  question_sent_at: Date | null;
  decided_at: Date | null;
  decision_source: DecisionSource | null;
  contact_phone_snapshot: string | null;
  server_question: boolean;
}

export interface DecisionOutcome {
  accepted: boolean;
  decision: Decision;
  decidedAt: Date | null;
  /** Set when the response was refused; surfaced honestly in the UI (D7). */
  reason: string | null;
  contactSmsCreated: boolean;
}

export interface RespondInput {
  incidentId: string;
  choice: ResponseChoice;
  source: ResponseSource;
  responderUserId?: string | null;
  idempotencyKey: string;
  deviceTime?: Date | null;
}

export interface DecisionServiceDeps {
  prisma: PrismaClient;
  clock: Clock;
  realtime: RealtimeEmitter;
}

/** The decisions that mean "the rider may need help" and so trigger contact SMS. */
const ESCALATING: Decision[] = ['HELP', 'TIMEOUT', 'OFFLINE_FALLBACK'];

export class DecisionService {
  constructor(private readonly deps: DecisionServiceDeps) {}

  /**
   * Locks the incident row for the rest of the transaction. Everything that can
   * change a decision goes through here first.
   */
  private static async lock(
    tx: Prisma.TransactionClient,
    incidentId: string,
  ): Promise<LockedIncident | null> {
    const rows = await tx.$queryRaw<LockedIncident[]>`
      SELECT id, owner_id, driver_id, bike_id, device_id, decision, state::text AS state,
             type::text AS type, response_deadline_at, question_sent_at, decided_at,
             decision_source, contact_phone_snapshot, server_question
      FROM incidents
      WHERE id = ${incidentId}::uuid
      FOR UPDATE
    `;
    return rows[0] ?? null;
  }

  /**
   * D3 - HELP, TIMEOUT and OFFLINE_FALLBACK each create the single logical
   * CONTACT_SMS, in the same transaction as the decision itself. D8: a device
   * that escalated offline reconciles into the *same* row, never a second one.
   */
  private static async applyDecision(
    tx: Prisma.TransactionClient,
    incident: LockedIncident,
    decision: Decision,
    source: DecisionSource,
    at: Date,
  ): Promise<boolean> {
    const state = decision === 'SAFE' ? 'RESOLVED_SAFE' : 'ESCALATED';

    await tx.incident.update({
      where: { id: incident.id },
      data: { decision, decisionSource: source, decidedAt: at, state },
    });

    if (!ESCALATING.includes(decision)) return false;

    const { created } = await ensureNotification(tx, {
      incidentId: incident.id,
      kind: 'CONTACT_SMS',
      recipientPhone: incident.contact_phone_snapshot,
      // REQUESTED, not sent: only the bike sends SMS (pinned decision). The
      // device reports the real attempt states back via §5.3.7.
      state: 'REQUESTED',
      at,
    });

    return created;
  }

  /**
   * §5.3.6 - the decision is pushed to the device as an INCIDENT_DECISION
   * command, which it acks once applied. Queued in the same transaction so a
   * decision can never exist without its command.
   */
  private static async queueDecisionCommand(
    tx: Prisma.TransactionClient,
    incident: LockedIncident,
    decision: Decision,
    at: Date,
  ): Promise<void> {
    if (!incident.device_id) return;
    // OFFLINE_FALLBACK originated on the device; it already knows.
    if (decision === 'OFFLINE_FALLBACK') return;

    await tx.deviceCommand.create({
      data: {
        deviceId: incident.device_id,
        type: 'INCIDENT_DECISION',
        payload: { eventId: incident.id, decision } as Prisma.InputJsonValue,
        incidentId: incident.id,
        status: 'QUEUED',
        expiresAt: addSeconds(at, INCIDENT_DECISION_COMMAND_TTL_SEC),
      },
    });
  }

  private emitDecision(incident: LockedIncident, decision: Decision, at: Date): void {
    const payload = {
      incidentId: incident.id,
      decision,
      decidedAt: toIsoRequired(at),
      deviceSynced: false,
    };
    this.deps.realtime.toOwner(incident.owner_id, 'incident.decision', payload);
    if (incident.driver_id) this.deps.realtime.toUser(incident.driver_id, 'incident.decision', payload);
  }

  /**
   * A driver-app or device-button response.
   *
   * D1 - accepted only while `decision = PENDING` and `now < responseDeadlineAt`.
   * D5 - a local SAFE loses if HELP/TIMEOUT already landed.
   * D7 - a losing response is still stored, with `accepted = false` and a reason,
   *      so the timeline can say "Safe received after emergency SMS submission".
   */
  async respond(input: RespondInput): Promise<DecisionOutcome> {
    const { prisma, clock } = this.deps;
    const now = clock.now();

    const result = await prisma.$transaction(async (tx) => {
      // Idempotency first: a retried submit must not create a second response.
      const replay = await tx.driverResponse.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        select: { accepted: true, rejectReason: true, incidentId: true },
      });

      if (replay) {
        const incident = await tx.incident.findUniqueOrThrow({
          where: { id: replay.incidentId },
          select: { decision: true, decidedAt: true },
        });
        return {
          accepted: replay.accepted,
          decision: incident.decision,
          decidedAt: incident.decidedAt,
          reason: replay.rejectReason,
          contactSmsCreated: false,
          emit: null,
        };
      }

      const incident = await DecisionService.lock(tx, input.incidentId);
      if (!incident) return null;

      const deadline = incident.response_deadline_at;
      const decidable =
        incident.decision === 'PENDING' && deadline !== null && now.getTime() < deadline.getTime();

      /**
       * D7: the reason is specific, because the UI shows it verbatim.
       *
       * The deadline takes precedence over "already decided": once the window
       * has closed, TOO_LATE is what actually happened to this response, even
       * though a TIMEOUT decision also exists by then. ALREADY_DECIDED is
       * reserved for a response that arrived *inside* the window but lost the
       * race to another claimant.
       *
       * TODO(spec): §5.4.3 returns `TOO_LATE` for exactly this case while the
       * §5.3.6 example prints `ALREADY_DECIDED` for it. They cannot both be
       * right; this reports the cause rather than the consequence.
       */
      const pastDeadline = deadline === null || now.getTime() >= deadline.getTime();
      const reason = decidable ? null : pastDeadline ? 'TOO_LATE' : 'ALREADY_DECIDED';

      await tx.driverResponse.create({
        data: {
          incidentId: incident.id,
          choice: input.choice,
          source: input.source,
          responderUserId: input.responderUserId ?? null,
          idempotencyKey: input.idempotencyKey,
          deviceTime: input.deviceTime ?? null,
          serverReceivedAt: now,
          accepted: decidable,
          rejectReason: reason,
        },
      });

      if (!decidable) {
        return {
          accepted: false,
          decision: incident.decision,
          decidedAt: incident.decided_at,
          reason,
          contactSmsCreated: false,
          emit: null,
        };
      }

      const decision: Decision = input.choice === 'SAFE' ? 'SAFE' : 'HELP';
      const source: DecisionSource = input.source === 'APP' ? 'APP' : 'DEVICE_BUTTON';

      const contactSmsCreated = await DecisionService.applyDecision(tx, incident, decision, source, now);
      await DecisionService.queueDecisionCommand(tx, incident, decision, now);

      // The driver answered, so the prompt is answered (FR-NOT-01).
      if (input.source === 'APP') {
        await tx.notification.updateMany({
          where: { incidentId: incident.id, kind: 'DRIVER_PROMPT' },
          data: { state: 'RESPONDED' },
        });
      }

      return {
        accepted: true,
        decision,
        decidedAt: now,
        reason: null,
        contactSmsCreated,
        emit: { incident, decision },
      };
    });

    if (!result) {
      return { accepted: false, decision: 'PENDING', decidedAt: null, reason: 'NOT_FOUND', contactSmsCreated: false };
    }

    if (result.emit) this.emitDecision(result.emit.incident, result.emit.decision, now);

    return {
      accepted: result.accepted,
      decision: result.decision,
      decidedAt: result.decidedAt,
      reason: result.reason,
      contactSmsCreated: result.contactSmsCreated,
    };
  }

  /**
   * D2 - the deadline worker (and every control poll, so the device does not
   * wait on worker lag) sets TIMEOUT only while `decision = PENDING` and
   * `serverNow >= responseDeadlineAt`.
   *
   * Safe to call from anywhere, any number of times: the row lock plus the
   * PENDING check mean only the first caller past the deadline does anything.
   */
  async evaluateDeadline(incidentId: string): Promise<DecisionOutcome | null> {
    const { prisma, clock } = this.deps;
    const now = clock.now();

    const result = await prisma.$transaction(async (tx) => {
      const incident = await DecisionService.lock(tx, incidentId);
      if (!incident) return null;

      const deadline = incident.response_deadline_at;
      if (incident.decision !== 'PENDING' || deadline === null) return null;
      if (now.getTime() < deadline.getTime()) return null;

      const contactSmsCreated = await DecisionService.applyDecision(
        tx,
        incident,
        'TIMEOUT',
        'SERVER_TIMER',
        now,
      );
      await DecisionService.queueDecisionCommand(tx, incident, 'TIMEOUT', now);

      // Nobody answered; say so rather than leaving the prompt "requested".
      await tx.notification.updateMany({
        where: { incidentId: incident.id, kind: 'DRIVER_PROMPT' },
        data: { state: 'OUTCOME_UNKNOWN' },
      });

      return { incident, contactSmsCreated };
    });

    if (!result) return null;

    this.emitDecision(result.incident, 'TIMEOUT', now);

    return {
      accepted: true,
      decision: 'TIMEOUT',
      decidedAt: now,
      reason: null,
      contactSmsCreated: result.contactSmsCreated,
    };
  }

  /**
   * D8 - reconciles a decision the device made while offline.
   *
   * If the server has already decided, the device's report is recorded as
   * history and both facts are shown; it never creates a second CONTACT_SMS.
   * If the server is still PENDING, the device's decision stands - it is the
   * one that actually happened out on the road.
   */
  async reconcileLocalDecision(input: {
    incidentId: string;
    decision: 'OFFLINE_FALLBACK' | 'SAFE' | 'HELP';
    source: 'DEVICE_BUTTON' | 'DEVICE_OFFLINE_TIMER';
    decidedAt: Date;
  }): Promise<DecisionOutcome | null> {
    const { prisma, clock } = this.deps;
    const now = clock.now();

    const result = await prisma.$transaction(async (tx) => {
      const incident = await DecisionService.lock(tx, input.incidentId);
      if (!incident) return null;

      if (incident.decision !== 'PENDING') {
        // Already decided by the app or the worker. Keep the server decision,
        // never a second contact SMS (D8) - but keep the bike's account too:
        // "if the server had decided SAFE but the device escalated offline,
        // both facts are shown". The detail timeline reads this row.
        await tx.auditEvent.create({
          data: {
            actorType: 'DEVICE',
            actorId: incident.device_id,
            action: 'DEVICE_LOCAL_DECISION',
            targetType: 'INCIDENT',
            targetId: incident.id,
            meta: {
              decision: input.decision,
              source: input.source,
              decidedAt: input.decidedAt.toISOString(),
              serverDecision: incident.decision,
            },
            createdAt: now,
          },
        });
        return { incident, applied: false, contactSmsCreated: false };
      }

      const source: DecisionSource =
        input.source === 'DEVICE_BUTTON' ? 'DEVICE_BUTTON' : 'DEVICE_OFFLINE_TIMER';

      const contactSmsCreated = await DecisionService.applyDecision(
        tx,
        incident,
        input.decision,
        source,
        input.decidedAt,
      );

      return { incident, applied: true, contactSmsCreated };
    });

    if (!result) return null;

    if (result.applied) this.emitDecision(result.incident, input.decision, input.decidedAt);

    return {
      accepted: result.applied,
      decision: result.applied ? input.decision : result.incident.decision,
      decidedAt: result.applied ? input.decidedAt : result.incident.decided_at,
      reason: result.applied ? null : 'ALREADY_DECIDED',
      contactSmsCreated: result.contactSmsCreated,
    };
  }

  /** §5.3.6 control-poll payload, after the deadline has been evaluated. */
  async controlState(incidentId: string): Promise<{
    decision: Decision;
    commandId: string | null;
    responseDeadlineAt: string | null;
    decidedAt: string | null;
  } | null> {
    // D2/D4: evaluating here means the device learns at its 3 s poll rather than
    // waiting for the 1 s worker to come round.
    await this.evaluateDeadline(incidentId);

    const incident = await this.deps.prisma.incident.findUnique({
      where: { id: incidentId },
      select: { decision: true, responseDeadlineAt: true, decidedAt: true },
    });
    if (!incident) return null;

    const command =
      incident.decision === 'PENDING'
        ? null
        : await this.deps.prisma.deviceCommand.findFirst({
            where: { incidentId, type: 'INCIDENT_DECISION' },
            orderBy: { createdAt: 'asc' },
            select: { id: true },
          });

    return {
      decision: incident.decision,
      commandId: command?.id ?? null,
      responseDeadlineAt: toIso(incident.responseDeadlineAt),
      decidedAt: toIso(incident.decidedAt),
    };
  }
}
