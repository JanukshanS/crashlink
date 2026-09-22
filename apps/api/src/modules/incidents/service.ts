/**
 * §5.3.5 incident upsert and classification.
 *
 * The rules that must be exactly right (§4.3):
 *  - idempotent on the device `eventId`, which *is* the incident id (§5.6.4);
 *  - recipient snapshots are copied from the rental row and never updated - the
 *    device's reported last-4 digits are only a consistency check;
 *  - a rental is resolved by `(bikeId, assignmentVersion)`; a mismatch is
 *    quarantined, never dropped (FR-INC-06);
 *  - SECURITY and INFO incidents never create a driver question (FR-INC-09).
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import {
  type IncidentCategory,
  type IncidentType,
  type IncidentUpsertRequest,
  type IncidentSummaryDto,
  incidentTypeLabel,
} from '@crashlink/contracts';
import { addSeconds, toIso, toIsoRequired, type Clock } from '../../lib/time.js';
import { scoreForIncident, severityOf } from '../../lib/severity.js';
import { computeIntegrityHash } from '../../lib/integrity.js';
import { ensureNotification, recordAttempt } from '../notifications/service.js';
import type { PushSender } from '../../lib/push.js';
import type { RealtimeEmitter } from '../../lib/realtime.js';

/** §5.3.8 - the category each incident type belongs to. */
export const INCIDENT_CATEGORY: Record<IncidentType, IncidentCategory> = {
  POSSIBLE_COLLISION: 'EMERGENCY',
  POSSIBLE_LOW_SPEED_RIDER_DROP: 'EMERGENCY',
  POSSIBLE_ROLLOVER: 'EMERGENCY',
  MANUAL_SOS: 'EMERGENCY',
  PARKED_BIKE_FALL: 'SECURITY',
  POSSIBLE_TOWING: 'SECURITY',
  POSSIBLE_TAMPERING: 'SECURITY',
  DEVICE_OFFLINE_DURING_RENTAL: 'SECURITY',
  POSSIBLE_POTHOLE: 'INFO',
  POSSIBLE_DANGEROUS_CORNERING: 'INFO',
};

export interface IncidentUpsertResult {
  incidentId: string;
  state: string;
  decision: string;
  serverQuestion: boolean;
  questionSentAt: Date | null;
  responseDeadlineAt: Date | null;
  created: boolean;
  quarantined: boolean;
}

export interface IncidentServiceDeps {
  prisma: PrismaClient;
  clock: Clock;
  realtime: RealtimeEmitter;
  responseWindowSec: number;
  /** FCM (team decision 22 Sep 2026): reaches a phone whose app is closed. */
  push?: PushSender;
}

export const toIncidentSummary = (incident: {
  id: string;
  bikeId: string;
  type: IncidentType;
  category: IncidentCategory;
  state: string;
  decision: string;
  severityScore: number | null;
  occurredAt: Date;
  responseDeadlineAt: Date | null;
  photoStatus: string;
  quarantined: boolean;
  isDemo: boolean;
  bike?: { label: string } | null;
}): IncidentSummaryDto =>
  ({
    id: incident.id,
    bikeId: incident.bikeId,
    bikeLabel: incident.bike?.label ?? '',
    type: incident.type,
    category: incident.category,
    // Appendix D: the honest "Possible ..." label, never invented by the UI.
    label: incidentTypeLabel(incident.type),
    state: incident.state,
    decision: incident.decision,
    severity: severityOf(incident.severityScore, incident.type),
    occurredAt: toIsoRequired(incident.occurredAt),
    responseDeadlineAt: toIso(incident.responseDeadlineAt),
    photoStatus: incident.photoStatus,
    quarantined: incident.quarantined,
    isDemo: incident.isDemo,
  }) as IncidentSummaryDto;

/**
 * §5.6.5 / FR-INC-11 - computes and stores the integrity hash from the row
 * **as the database holds it**.
 *
 * Reading back rather than hashing the request matters: Postgres JSONB
 * reorders keys and normalises numbers, and the detail view recomputes from
 * the stored row. Hashing the request would make every honest record look
 * tampered with.
 *
 * Every creation path calls this - device upsert, the dead-man worker and app
 * SOS - so no incident exists without a hash.
 */
export const stampIntegrityHash = async (
  client: Prisma.TransactionClient | PrismaClient,
  incidentId: string,
  photoSha256: string | null,
): Promise<string | null> => {
  const row = await client.incident.findUnique({
    where: { id: incidentId },
    select: {
      id: true,
      bikeId: true,
      type: true,
      occurredAt: true,
      lat: true,
      lon: true,
      fixAt: true,
      evidence: true,
      sensorWindow: true,
    },
  });
  if (!row) return null;

  const integrityHash = computeIntegrityHash({ ...row, photoSha256 });
  await client.incident.update({ where: { id: incidentId }, data: { integrityHash } });
  return integrityHash;
};

export class IncidentService {
  constructor(private readonly deps: IncidentServiceDeps) {}

  /**
   * §5.3.5. `eventId` is the primary key, so a duplicate PUT returns the
   * current state rather than creating anything (FR-INC-01).
   */
  async upsertFromDevice(input: {
    deviceId: string;
    bikeId: string;
    ownerId: string;
    isDemo: boolean;
    body: IncidentUpsertRequest;
  }): Promise<IncidentUpsertResult> {
    const { prisma, clock } = this.deps;
    const now = clock.now();
    const body = input.body;

    const existing = await prisma.incident.findUnique({
      where: { id: body.eventId },
      select: {
        id: true,
        state: true,
        decision: true,
        serverQuestion: true,
        questionSentAt: true,
        responseDeadlineAt: true,
        quarantined: true,
        photoStatus: true,
      },
    });

    if (existing) {
      // FR-IMG-03: the one field a repeat report may change - a photo still
      // waiting may be declared FAILED (the camera capture did not work), so
      // the owner stops seeing "Waiting for photo". Never overrides progress.
      if (body.photoStatus === 'FAILED' && (existing.photoStatus === 'PENDING' || existing.photoStatus === 'NOT_REQUESTED')) {
        await prisma.incident.updateMany({
          where: { id: existing.id, photoStatus: { in: ['PENDING', 'NOT_REQUESTED'] } },
          data: { photoStatus: 'FAILED' },
        });
      }
      return {
        incidentId: existing.id,
        state: existing.state,
        decision: existing.decision,
        serverQuestion: existing.serverQuestion,
        questionSentAt: existing.questionSentAt,
        responseDeadlineAt: existing.responseDeadlineAt,
        created: false,
        quarantined: existing.quarantined,
      };
    }

    const category = INCIDENT_CATEGORY[body.type];

    // §5.3.5 step 2: resolve the rental by (bike, assignmentVersion).
    const rental =
      body.assignmentVersion === null
        ? null
        : await prisma.rental.findUnique({
            where: {
              bikeId_assignmentVersion: {
                bikeId: input.bikeId,
                assignmentVersion: body.assignmentVersion,
              },
            },
          });

    // FR-INC-06: the device believes it is on a rental we cannot confirm, or on
    // a different one. Store it, flag it, ask nothing - a question sent to the
    // wrong rider is worse than no question.
    const mismatch =
      body.assignmentVersion !== null &&
      (!rental || (body.rentalId !== null && rental.id !== body.rentalId));

    const quarantineReason = mismatch
      ? !rental
        ? `No rental for assignmentVersion ${body.assignmentVersion}`
        : `Device reported rental ${body.rentalId}, bike is on ${rental.id}`
      : null;

    const matchedRental = mismatch ? null : rental;

    const evidence = body.evidence as Prisma.InputJsonValue;
    // §5.6.5 severity: EMERGENCY falls only, never SOS (see scoreForIncident).
    const score = scoreForIncident(body.type, category, {
      peakAccelerationG: body.evidence.peakAccelerationG ?? null,
      peakRotationDps: body.evidence.peakRotationDps ?? null,
      preEventSpeedKph: body.preEventSpeedKph,
      fallenDurationMs: body.evidence.fallenDurationMs ?? null,
    });

    // §5.3.5 step 4/5 and FR-INC-09.
    const hasLocalDecision = Boolean(body.localDecision);
    const isEmergency = category === 'EMERGENCY';
    const serverQuestion =
      isEmergency && matchedRental !== null && !hasLocalDecision && body.type !== 'MANUAL_SOS';

    let state: string;
    let decision: string;
    let decisionSource: string | null = null;
    let decidedAt: Date | null = null;

    if (body.type === 'MANUAL_SOS') {
      // §5.3.5 step 5: the rider pressed SOS. There is nothing to ask.
      state = 'ESCALATED';
      decision = 'HELP';
      decisionSource = 'DEVICE_BUTTON';
      decidedAt = body.localDecision ? new Date(body.localDecision.decidedAt) : now;
    } else if (hasLocalDecision && isEmergency) {
      const local = body.localDecision!;
      decision = local.decision;
      decisionSource = local.source === 'DEVICE_BUTTON' ? 'DEVICE_BUTTON' : 'DEVICE_OFFLINE_TIMER';
      decidedAt = new Date(local.decidedAt);
      state = local.decision === 'SAFE' ? 'RESOLVED_SAFE' : 'ESCALATED';
    } else if (serverQuestion) {
      state = 'AWAITING_RESPONSE';
      decision = 'PENDING';
    } else if (category === 'INFO') {
      state = 'INFO_RECORDED';
      decision = 'NOT_APPLICABLE';
    } else {
      // SECURITY, or EMERGENCY with no rental to ask (quarantined).
      state = 'OPEN';
      decision = isEmergency ? 'PENDING' : 'NOT_APPLICABLE';
    }

    // The bike had no fix (cold GPS, indoors): fall back to its last known GPS
    // position, labelled LAST_KNOWN with its real age - never passed off as live.
    let location = body.location;
    if (location.kind === 'UNAVAILABLE') {
      const last = await prisma.bike.findUnique({
        where: { id: input.bikeId },
        select: { lastLat: true, lastLon: true, lastFixAt: true, lastLocationSource: true },
      });
      if (last?.lastLat != null && last.lastLon != null && last.lastFixAt && last.lastLocationSource === 'GPS') {
        location = {
          kind: 'LAST_KNOWN',
          lat: last.lastLat,
          lon: last.lastLon,
          fixAt: last.lastFixAt.toISOString(),
          ageSecondsAtEvent: Math.max(0, Math.round((new Date(body.occurredAt).getTime() - last.lastFixAt.getTime()) / 1000)),
          src: 'GPS',
        };
      }
    }

    const questionSentAt = serverQuestion ? now : null;
    const responseDeadlineAt = serverQuestion
      ? addSeconds(now, this.deps.responseWindowSec)
      : null;

    const created = await prisma.$transaction(async (tx) => {
      const incident = await tx.incident.create({
        data: {
          // §5.6.4: incident id IS the device eventId.
          id: body.eventId,
          bikeId: input.bikeId,
          deviceId: input.deviceId,
          rentalId: matchedRental?.id ?? null,
          driverId: matchedRental?.driverId ?? null,
          ownerId: input.ownerId,
          type: body.type,
          category,
          state: state as never,
          severityScore: score,
          occurredAt: new Date(body.occurredAt),
          receivedAt: now,
          timeSource: body.timeSource,
          ignitionAtEvent: body.ignition,
          preEventSpeedKph: body.preEventSpeedKph,
          locationKind: location.kind,
          lat: location.lat,
          lon: location.lon,
          fixAt: location.fixAt ? new Date(location.fixAt) : null,
          fixAgeSec: location.ageSecondsAtEvent,
          locationSource: location.src,
          evidence,
          sensorWindow: (body.sensorWindow ?? null) as Prisma.InputJsonValue,
          assignmentVersion: body.assignmentVersion,
          // §5.3.5 step 3: snapshots come from the rental row, not the device.
          ownerPhoneSnapshot: matchedRental?.ownerPhoneSnapshot ?? null,
          driverNameSnapshot: matchedRental?.driverNameSnapshot ?? null,
          contactNameSnapshot: matchedRental?.contactNameSnapshot ?? null,
          contactPhoneSnapshot: matchedRental?.contactPhoneSnapshot ?? null,
          serverQuestion,
          questionSentAt,
          responseDeadlineAt,
          decision: decision as never,
          decisionSource: decisionSource as never,
          decidedAt,
          photoStatus: body.photoStatus,
          quarantined: mismatch,
          quarantineReason,
          isDemo: input.isDemo || body.evidence.simulated === true,
        },
      });

      // §5.3.5 step 4: the question and the owner's push, as logical rows.
      if (serverQuestion) {
        await ensureNotification(tx, {
          incidentId: incident.id,
          kind: 'DRIVER_PROMPT',
          state: 'REQUESTED',
          at: now,
        });
      }

      if (isEmergency || category === 'SECURITY') {
        await ensureNotification(tx, {
          incidentId: incident.id,
          kind: 'OWNER_PUSH',
          state: 'REQUESTED',
          at: now,
        });
      }

      // MANUAL_SOS and a device that already escalated both mean the contact is
      // being texted by the bike; record the single logical notification (D3).
      if (decision === 'HELP' || decision === 'OFFLINE_FALLBACK') {
        await ensureNotification(tx, {
          incidentId: incident.id,
          kind: 'CONTACT_SMS',
          recipientPhone: matchedRental?.contactPhoneSnapshot ?? null,
          state: 'REQUESTED',
          at: now,
        });
      }

      // FR-INC-11: hash the evidence as stored, so it can be recomputed later.
      await stampIntegrityHash(tx, incident.id, null);

      return tx.incident.findUniqueOrThrow({
        where: { id: incident.id },
        include: { bike: { select: { label: true } } },
      });
    });

    // §5.5 - the owner always hears about it; the driver only gets the question.
    const summary = toIncidentSummary(created as never);
    this.deps.realtime.toOwner(input.ownerId, 'incident.created', summary);

    if (serverQuestion && matchedRental) {
      this.deps.realtime.toUser(matchedRental.driverId, 'incident.question', {
        incidentId: created.id,
        label: incidentTypeLabel(created.type),
        occurredAt: toIsoRequired(created.occurredAt),
        questionSentAt: toIsoRequired(questionSentAt!),
        responseDeadlineAt: toIsoRequired(responseDeadlineAt!),
        serverTime: toIsoRequired(now),
      });
    }

    // Push is an attention aid on top of the socket and the bike's SMS, and it
    // must never delay or fail the incident - hence after the transaction, and
    // never awaited into the caller's path.
    void this.pushForIncident({
      incidentId: created.id,
      label: incidentTypeLabel(created.type),
      bikeLabel: created.bike?.label ?? '',
      ownerId: input.ownerId,
      driverId: serverQuestion && matchedRental ? matchedRental.driverId : null,
      isEmergency,
      at: now,
    });

    return {
      incidentId: created.id,
      state: created.state,
      decision: created.decision,
      serverQuestion,
      questionSentAt,
      responseDeadlineAt,
      created: true,
      quarantined: mismatch,
    };
  }

  /** FR-NOT-04: the rider's question and the owner's alert, as push messages. */
  private async pushForIncident(input: {
    incidentId: string;
    label: string;
    bikeLabel: string;
    ownerId: string;
    driverId: string | null;
    isEmergency: boolean;
    at: Date;
  }): Promise<void> {
    const push = this.deps.push;
    if (!push) return;

    try {
      if (input.driverId) {
        const accepted = await push.sendToUser(input.driverId, {
          title: 'Are you safe?',
          body: `${input.label} on ${input.bikeLabel} - tap to answer`,
          data: { type: 'INCIDENT_QUESTION', incidentId: input.incidentId },
          channelId: 'emergency',
        });
        if (accepted > 0) {
          await this.deps.prisma.$transaction(async (tx) => {
            const { id } = await ensureNotification(tx, { incidentId: input.incidentId, kind: 'DRIVER_PROMPT', at: input.at });
            // Firebase took it; that is not proof the phone showed it (NFR-04).
            await recordAttempt(tx, { notificationId: id, attemptNo: 1, state: 'PROVIDER_ACCEPTED' });
          });
        }
      }

      const ownerAccepted = await push.sendToUser(input.ownerId, {
        title: input.label,
        body: `${input.bikeLabel} - tap to open`,
        data: { type: 'INCIDENT_CREATED', incidentId: input.incidentId },
        channelId: input.isEmergency ? 'emergency' : 'security',
      });
      if (ownerAccepted > 0) {
        await this.deps.prisma.$transaction(async (tx) => {
          const { id } = await ensureNotification(tx, { incidentId: input.incidentId, kind: 'OWNER_PUSH', at: input.at });
          await recordAttempt(tx, { notificationId: id, attemptNo: 1, state: 'PROVIDER_ACCEPTED' });
        });
      }
    } catch {
      // A push that cannot be sent is never allowed to affect the incident.
    }
  }

  /**
   * §5.6.5: recomputed when the photo completes, so the hash also covers the
   * photo's SHA-256. A failed upload passes null - an unverified photo is not
   * part of the evidence.
   */
  async refreshIntegrityHash(incidentId: string, photoSha256: string | null): Promise<void> {
    await stampIntegrityHash(this.deps.prisma, incidentId, photoSha256);
  }
}
