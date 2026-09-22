/**
 * §5.4.3 (responses, question-ack) and §5.4.6 (incidents & images), app side.
 *
 * A DRIVER sees their own incidents without any photo field (§5.7.2); an OWNER
 * sees their fleet; a GUEST reads the demo owner's data. Everything is
 * ownership-scoped and a foreign id is a 404.
 */
import { createReadStream } from 'node:fs';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import {
  AcknowledgeIncidentRequestSchema,
  DriverResponseRequestSchema,
  ListIncidentsQuerySchema,
  PaginationQuerySchema,
  SEVERITY_DISCLAIMER,
  UuidSchema,
  incidentTypeLabel,
  maskPhone,
} from '@crashlink/contracts';
import { requireUser } from '../../plugins/auth.js';
import {
  assertCanSeeIncident,
  canSeeFullPhones,
  resolveReadScope,
  scopeWhere,
} from '../../lib/ownership.js';
import { AppError, notFound } from '../../lib/errors.js';
import { toIso, toIsoRequired } from '../../lib/time.js';
import { severityOf } from '../../lib/severity.js';
import { computeIntegrityHash, integrityMatches } from '../../lib/integrity.js';
import { toIncidentSummary } from './service.js';
import type { DecisionService } from './decision.service.js';
import type { ImageService } from '../images/service.js';
import type { AppDeps } from '../../app.js';

export interface IncidentRoutesDeps {
  decisions: DecisionService;
  images: ImageService;
  app: AppDeps;
}

export const registerIncidentRoutes = async (
  app: FastifyInstance,
  deps: IncidentRoutesDeps,
): Promise<void> => {
  const { decisions, images } = deps;
  const { clock } = deps.app;

  // §5.7.2 Incidents: OWNER R own + ack, DRIVER R own, ADMIN R, GUEST R demo.
  const readers = [app.authenticate, app.requireRole('OWNER', 'GUEST', 'ADMIN')];
  const anyRole = [app.authenticate, app.requireRole('OWNER', 'DRIVER', 'GUEST', 'ADMIN')];
  const driverOnly = [app.authenticate, app.requireRole('DRIVER')];
  const ownerOnly = [app.authenticate, app.requireRole('OWNER')];
  // §5.7.2 Images: OWNER own, ADMIN all; FR-IMG-02 "the owning owner (and admin)".
  const imageReaders = [app.authenticate, app.requireRole('OWNER', 'ADMIN')];

  // --- §5.4.6 list ---------------------------------------------------------
  app.get('/incidents', { preHandler: readers }, async (request, reply) => {
    const auth = requireUser(request);
    const scope = await resolveReadScope(app.prisma, auth);
    const filters = ListIncidentsQuerySchema.parse(request.query ?? {});
    const page = PaginationQuerySchema.parse(request.query ?? {});

    const rows = await app.prisma.incident.findMany({
      where: {
        ...scopeWhere(scope),
        ...(filters.category ? { category: filters.category } : {}),
        ...(filters.type ? { type: filters.type } : {}),
        ...(filters.state ? { state: filters.state } : {}),
        ...(filters.bikeId ? { bikeId: filters.bikeId } : {}),
        ...(filters.from || filters.to
          ? {
              occurredAt: {
                ...(filters.from ? { gte: new Date(filters.from) } : {}),
                ...(filters.to ? { lte: new Date(filters.to) } : {}),
              },
            }
          : {}),
      },
      include: { bike: { select: { label: true } } },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: page.limit + 1,
      ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > page.limit;
    const items = hasMore ? rows.slice(0, page.limit) : rows;

    return reply.send({
      items: items.map((row) => toIncidentSummary(row as never)),
      nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null,
    });
  });

  // --- §5.4.6 detail -------------------------------------------------------
  app.get<{ Params: { id: string } }>('/incidents/:id', { preHandler: anyRole }, async (request, reply) => {
    const auth = requireUser(request);
    const isDriver = auth.role === 'DRIVER';
    const scope = isDriver ? undefined : await resolveReadScope(app.prisma, auth);

    await assertCanSeeIncident(app.prisma, auth, request.params.id, scope);

    const incident = await app.prisma.incident.findUnique({
      where: { id: request.params.id },
      include: {
        bike: { select: { id: true, label: true } },
        rental: true,
        image: true,
        responses: { orderBy: { serverReceivedAt: 'asc' } },
        notifications: { include: { attempts: { orderBy: { createdAt: 'asc' } } } },
      },
    });
    if (!incident) throw notFound('Incident');

    // D8: facts the bike reported that did not change the server's decision.
    const deviceFacts = await app.prisma.auditEvent.findMany({
      where: { targetType: 'INCIDENT', targetId: incident.id, action: 'DEVICE_LOCAL_DECISION' },
      orderBy: { createdAt: 'asc' },
    });

    // §5.7.3 / §2.1: full numbers only in the owner's own view.
    const fullPhones = canSeeFullPhones(auth);
    const show = (phone: string | null): string | null => (fullPhones ? phone : maskPhone(phone));

    const prompt = incident.notifications.find((n) => n.kind === 'DRIVER_PROMPT');

    // §5.6.5: "verified" means a fresh recomputation matches what we stored.
    const recomputed = computeIntegrityHash({
      id: incident.id,
      bikeId: incident.bikeId,
      type: incident.type,
      occurredAt: incident.occurredAt,
      lat: incident.lat,
      lon: incident.lon,
      fixAt: incident.fixAt,
      evidence: incident.evidence,
      sensorWindow: incident.sensorWindow,
      photoSha256: incident.image?.sha256Actual ?? null,
    });

    /**
     * FR-IMG-03: the photo status comes from the incident itself, so PENDING
     * shows before the bike has even opened an upload session, and UPLOADING
     * carries a real fraction. Drivers get no photo fields at all (§5.7.2).
     *
     * `expired`: the incident had a verified photo that retention later
     * deleted. Reporting that honestly beats "no photo requested".
     */
    const image = incident.image;
    const photo = isDriver
      ? null
      : {
          status: incident.photoStatus,
          bytes: image?.state === 'COMPLETE' ? image.receivedBytes : null,
          sha256: image?.sha256Actual ?? null,
          progress:
            image && image.state !== 'COMPLETE' && image.expectedBytes > 0
              ? Math.min(1, image.receivedBytes / image.expectedBytes)
              : null,
          expired: incident.photoStatus === 'AVAILABLE' && !image,
          integrity:
            image?.state !== 'COMPLETE'
              ? ('UNVERIFIED' as const)
              : integrityMatches(incident.integrityHash, recomputed)
                ? ('VERIFIED' as const)
                : ('MISMATCH' as const),
        };

    return reply.send({
      id: incident.id,
      type: incident.type,
      label: incidentTypeLabel(incident.type),
      category: incident.category,
      state: incident.state,
      decision: incident.decision,
      decisionSource: incident.decisionSource,
      decidedAt: toIso(incident.decidedAt),
      severity: {
        ...severityOf(incident.severityScore, incident.type),
        // NFR-04: the disclaimer travels with the number, always.
        note: SEVERITY_DISCLAIMER,
      },
      occurredAt: toIsoRequired(incident.occurredAt),
      receivedAt: toIsoRequired(incident.receivedAt),
      timeSource: incident.timeSource,
      bike: { id: incident.bike.id, label: incident.bike.label },
      rental: incident.rental
        ? {
            id: incident.rental.id,
            driverName: incident.rental.driverNameSnapshot,
            driverPhone: show(incident.rental.driverPhoneSnapshot),
          }
        : null,
      contact: incident.contactPhoneSnapshot
        ? {
            name: incident.contactNameSnapshot ?? '',
            phone: show(incident.contactPhoneSnapshot) ?? '',
          }
        : null,
      ignitionAtEvent: incident.ignitionAtEvent,
      preEventSpeedKph: incident.preEventSpeedKph,
      location: {
        kind: incident.locationKind,
        lat: incident.lat,
        lon: incident.lon,
        fixAt: toIso(incident.fixAt),
        ageSecondsAtEvent: incident.fixAgeSec,
        source: incident.locationSource,
      },
      evidence: incident.evidence,
      sensorWindow: incident.sensorWindow,
      question:
        incident.questionSentAt && incident.responseDeadlineAt
          ? {
              sentAt: toIsoRequired(incident.questionSentAt),
              deadlineAt: toIsoRequired(incident.responseDeadlineAt),
              promptStates: prompt ? prompt.attempts.map((a) => a.state).concat(prompt.state) : [],
            }
          : null,
      responses: incident.responses.map((response) => ({
        choice: response.choice,
        source: response.source,
        serverAcceptedAt: toIsoRequired(response.serverReceivedAt),
        accepted: response.accepted,
        // D7: the honest reason, shown verbatim ("Safe received after ...").
        reason: response.rejectReason,
        syncedToDeviceAt: toIso(response.syncedToDeviceAt),
      })),
      notifications: incident.notifications.map((notification) => ({
        kind: notification.kind,
        state: notification.state,
        recipientMasked: notification.recipientMasked,
        attempts: notification.attempts.map((attempt) => ({
          attemptNo: attempt.attemptNo,
          state: attempt.state,
          at: toIsoRequired(attempt.createdAt),
          detail: attempt.detail,
        })),
      })),
      timeline: buildTimeline(incident, deviceFacts),
      photo,
      integrityHash: incident.integrityHash,
      ownerAckAt: toIso(incident.ownerAckAt),
      ownerNote: incident.ownerNote,
      quarantined: incident.quarantined,
      isDemo: incident.isDemo,
    });
  });

  // --- §5.4.3 question-ack -------------------------------------------------
  /** FR-NOT-02: the prompt may only say CLIENT_RECEIVED when the app says so. */
  app.post<{ Params: { id: string } }>(
    '/incidents/:id/question-ack',
    { preHandler: driverOnly },
    async (request, reply) => {
      const auth = requireUser(request);
      await assertCanSeeIncident(app.prisma, auth, request.params.id);

      await app.prisma.notification.updateMany({
        where: {
          incidentId: request.params.id,
          kind: 'DRIVER_PROMPT',
          state: { in: ['REQUESTED', 'QUEUED', 'PROVIDER_ACCEPTED'] },
        },
        data: { state: 'CLIENT_RECEIVED' },
      });

      return reply.status(204).send();
    },
  );

  // --- §5.4.3 responses ----------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/incidents/:id/responses',
    { preHandler: driverOnly },
    async (request, reply) => {
      const auth = requireUser(request);
      const body = DriverResponseRequestSchema.parse(request.body);

      // The driver must own the incident; a foreign id is a 404 (§5.7.2).
      await assertCanSeeIncident(app.prisma, auth, request.params.id);

      const outcome = await decisions.respond({
        incidentId: UuidSchema.parse(request.params.id),
        choice: body.choice,
        source: 'APP',
        responderUserId: auth.id,
        idempotencyKey: body.idempotencyKey,
      });

      if (!outcome.accepted) {
        // §5.4.3: 409 TOO_LATE carries the decision that actually won.
        throw new AppError('TOO_LATE', 'The response window for this incident has closed.', {
          decision: outcome.decision,
          decidedAt: toIso(outcome.decidedAt),
          reason: outcome.reason,
        });
      }

      const synced = await app.prisma.driverResponse.findUnique({
        where: { idempotencyKey: body.idempotencyKey },
        select: { syncedToDeviceAt: true },
      });

      return reply.send({
        accepted: true,
        decision: outcome.decision,
        serverAcceptedAt: toIsoRequired(outcome.decidedAt ?? clock.now()),
        // Honest: the bike has not confirmed until it acks the command.
        deviceSync: synced?.syncedToDeviceAt ? 'SYNCED' : 'PENDING',
      });
    },
  );

  // --- §5.4.6 acknowledge --------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/incidents/:id/acknowledge',
    { preHandler: ownerOnly },
    async (request, reply) => {
      const auth = requireUser(request);
      const body = AcknowledgeIncidentRequestSchema.parse(request.body ?? {});

      await assertCanSeeIncident(app.prisma, auth, request.params.id);

      const now = clock.now();
      const updated = await app.prisma.incident.update({
        where: { id: request.params.id },
        data: {
          state: 'CLOSED',
          ownerAckAt: now,
          ownerNote: body.note ?? null,
          closedAt: now,
        },
      });

      await app.prisma.auditEvent.create({
        data: {
          actorType: 'USER',
          actorId: auth.id,
          action: 'INCIDENT_ACKNOWLEDGED',
          targetType: 'INCIDENT',
          targetId: updated.id,
          meta: {},
        },
      });

      return reply.send({ state: updated.state, ownerAckAt: toIsoRequired(now) });
    },
  );

  // --- §5.4.6 signed image URL --------------------------------------------
  app.get<{ Params: { id: string } }>(
    '/incidents/:id/image-url',
    { preHandler: imageReaders },
    async (request, reply) => {
      const auth = requireUser(request);
      await assertCanSeeIncident(app.prisma, auth, request.params.id, await resolveReadScope(app.prisma, auth));

      const image = await app.prisma.incidentImage.findUnique({
        where: { incidentId: request.params.id },
      });
      // FR-IMG-02: only a verified, complete image is ever served.
      if (!image || image.state !== 'COMPLETE' || !image.storageKey || !image.sha256Actual) {
        throw notFound('Image');
      }

      const signature = images.signUrl(image.storageKey, clock.now());

      return reply.send({
        url: signature.url,
        expiresAt: toIsoRequired(signature.expiresAt),
        sha256: image.sha256Actual,
        bytes: image.receivedBytes,
      });
    },
  );

  // --- §5.4.6 signed image download (no bearer) ----------------------------
  app.get<{ Params: { '*': string }; Querystring: { exp?: string; sig?: string } }>(
    '/files/images/*',
    async (request, reply) => {
      const storageKey = request.params['*'];
      const exp = Number(request.query.exp);
      const sig = request.query.sig ?? '';

      if (!images.verifyUrlSignature(storageKey, exp, sig, clock.now())) {
        // Expired and forged links are the same answer.
        throw notFound('Image');
      }

      const path = images.resolveWithinImageDir(storageKey);
      if (!path || !existsSync(path)) throw notFound('Image');

      const size = (await stat(path)).size;

      return reply
        .header('content-type', 'image/jpeg')
        .header('content-length', size)
        // §5.4.6: private, never cached by a shared proxy.
        .header('cache-control', 'private, max-age=300')
        .send(createReadStream(path));
    },
  );
};

/**
 * §5.4.6 timeline - assembled from what actually happened, in order. Every
 * entry is a fact we hold a row for; nothing is inferred.
 */
const buildTimeline = (
  incident: {
  occurredAt: Date;
  receivedAt: Date;
  questionSentAt: Date | null;
  decidedAt: Date | null;
  decision: string;
  decisionSource: string | null;
  responses: { choice: string; accepted: boolean; serverReceivedAt: Date; rejectReason: string | null }[];
  notifications: {
    kind: string;
    attempts: { state: string; createdAt: Date; detail: string | null }[];
  }[];
  evidence: unknown;
  },
  deviceFacts: { createdAt: Date; meta: unknown }[] = [],
): { at: string; event: string; text: string }[] => {
  const entries: { at: Date; event: string; text: string }[] = [];

  // D8: "if the server had decided SAFE but the device escalated offline, both
  // facts are shown" - so the bike's own decision is a timeline entry too.
  for (const fact of deviceFacts) {
    const meta = (fact.meta ?? {}) as { decision?: string; source?: string; decidedAt?: string; serverDecision?: string };
    const at = meta.decidedAt ? new Date(meta.decidedAt) : fact.createdAt;
    entries.push({
      at: Number.isNaN(at.getTime()) ? fact.createdAt : at,
      event: 'DEVICE_LOCAL_DECISION',
      text:
        meta.decision === 'OFFLINE_FALLBACK'
          ? `Bike was offline and escalated on its own timer (server had already decided ${meta.serverDecision ?? 'otherwise'})`
          : `Bike reported "${meta.decision ?? '?'}" from its button after the server decided ${meta.serverDecision ?? 'otherwise'}`,
    });
  }

  const fallenMs = (incident.evidence as { fallenDurationMs?: number } | null)?.fallenDurationMs;
  entries.push({
    at: incident.occurredAt,
    event: 'DETECTED',
    text: fallenMs ? `Bike fallen for ${Math.round(fallenMs / 1000)} s` : 'Event detected by the bike',
  });

  entries.push({ at: incident.receivedAt, event: 'RECEIVED', text: 'Report received by the server' });

  if (incident.questionSentAt) {
    entries.push({
      at: incident.questionSentAt,
      event: 'QUESTION_SENT',
      text: 'Safety check sent to the rider',
    });
  }

  for (const notification of incident.notifications) {
    for (const attempt of notification.attempts) {
      entries.push({
        at: attempt.createdAt,
        event: `${notification.kind}_${attempt.state}`,
        text: describeAttempt(notification.kind, attempt.state, attempt.detail),
      });
    }
  }

  for (const response of incident.responses) {
    entries.push({
      at: response.serverReceivedAt,
      event: response.accepted ? 'RESPONSE_ACCEPTED' : 'RESPONSE_REJECTED',
      text: response.accepted
        ? `Rider answered "${response.choice === 'SAFE' ? "I'm safe" : 'Need help'}"`
        : response.rejectReason === 'TOO_LATE'
          ? `"${response.choice}" received after the response window closed`
          : `"${response.choice}" received after the incident was already decided`,
    });
  }

  if (incident.decidedAt) {
    entries.push({
      at: incident.decidedAt,
      event: 'DECIDED',
      text: describeDecision(incident.decision, incident.decisionSource),
    });
  }

  return entries
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .map((entry) => ({ at: toIsoRequired(entry.at), event: entry.event, text: entry.text }));
};

/** NFR-04: never claim delivery the modem did not report. */
const describeAttempt = (kind: string, state: string, detail: string | null): string => {
  const who =
    kind === 'OWNER_SMS'
      ? 'Owner SMS'
      : kind === 'CONTACT_SMS'
        ? 'Emergency contact SMS'
        : kind === 'DRIVER_SMS'
          ? 'Rider SMS'
          : kind;
  switch (state) {
    case 'QUEUED':
      return `${who} queued on the bike`;
    case 'AT_SUBMITTED':
      return `${who} submitted to the network${detail ? ` (${detail})` : ''}`;
    case 'NETWORK_CONFIRMED':
      return `${who} confirmed delivered by the network`;
    case 'FAILED':
      return `${who} failed${detail ? ` (${detail})` : ''}`;
    case 'OUTCOME_UNKNOWN':
      return `${who} outcome unknown - the bike reset mid-command`;
    case 'CLIENT_RECEIVED':
      return `${who} received by the app`;
    default:
      return `${who}: ${state}`;
  }
};

const describeDecision = (decision: string, source: string | null): string => {
  switch (decision) {
    case 'SAFE':
      return source === 'DEVICE_BUTTON' ? 'Rider pressed Safe on the bike' : 'Rider answered "I\'m safe"';
    case 'HELP':
      return source === 'DEVICE_BUTTON' ? 'Rider pressed SOS on the bike' : 'Rider asked for help';
    case 'TIMEOUT':
      return 'No answer within the response window - escalated';
    case 'OFFLINE_FALLBACK':
      return 'Bike was offline and escalated on its own timer';
    default:
      return `Decision: ${decision}`;
  }
};
