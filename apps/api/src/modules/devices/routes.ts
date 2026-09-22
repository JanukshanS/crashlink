/**
 * §5.3 device gateway - `/d/v1`.
 *
 * These handlers are deliberately thin: parse, validate, delegate to
 * DeviceIngestService, serialise. Every rule lives in the service so an MQTT
 * subscriber (§5.3.12) can reuse it unchanged.
 *
 * Auth is query-string HMAC (Appendix E.1.2) applied as a preHandler on every
 * route except `GET /time`, which is the unsigned clock bootstrap.
 */
import type { FastifyInstance } from 'fastify';
import {
  CommandAckRequestSchema,
  DeviceNotificationReportSchema,
  HeartbeatRequestSchema,
  IncidentControlAckRequestSchema,
  IncidentUpsertRequestSchema,
  LocalResponseRequestSchema,
  OpenImageSessionRequestSchema,
  UuidSchema,
} from '@crashlink/contracts';
import { registerDeviceAuth, requireDevice } from '../../plugins/deviceAuth.js';
import { AppError } from '../../lib/errors.js';
import { toIso, toIsoRequired } from '../../lib/time.js';
import type { DeviceIngestService } from './ingest.service.js';
import type { ImageService } from '../images/service.js';
import type { IncidentService } from '../incidents/service.js';
import type { AppDeps } from '../../app.js';

export interface DeviceRoutesDeps {
  ingest: DeviceIngestService;
  images: ImageService;
  incidents: IncidentService;
  app: AppDeps;
}

/** The raw body, parsed as JSON only after its signature has been verified. */
const jsonBody = (raw: Buffer | undefined): unknown => {
  if (!raw || raw.length === 0) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new AppError('VALIDATION_FAILED', 'Body is not valid JSON.');
  }
};

export const registerDeviceRoutes = async (
  scope: FastifyInstance,
  deps: DeviceRoutesDeps,
): Promise<void> => {
  const { ingest, images, incidents } = deps;
  const { config, clock } = deps.app;

  await registerDeviceAuth(scope, {
    deviceSecretKey: config.DEVICE_SECRET_KEY,
    clock,
  });

  // §5.4.10 60/min per device is enforced inside authenticateDevice, counted
  // on verified requests only (see plugins/deviceAuth.ts).
  const signed = { preHandler: scope.authenticateDevice };

  // --- §5.3.2 unsigned clock bootstrap --------------------------------------
  scope.get('/time', async (_request, reply) => reply.send(ingest.serverTime()));

  // --- §5.3.3 heartbeat -----------------------------------------------------
  scope.post('/heartbeat', signed, async (request, reply) => {
    const device = requireDevice(request);
    const body = HeartbeatRequestSchema.parse(jsonBody(request.rawBody));
    const result = await ingest.heartbeat(device, body);

    // Appendix E.1.3: keep the response under 1 KB - the counters are for the
    // simulator and tests, not the firmware.
    return reply.send({
      serverTime: result.serverTime,
      configVersion: result.configVersion,
      nextIntervalSec: result.nextIntervalSec,
      commands: result.commands,
      ...(result.lastKnown ? { lastKnown: result.lastKnown } : {}),
    });
  });

  // --- §5.3.4 command ack ---------------------------------------------------
  scope.post<{ Params: { id: string } }>('/commands/:id/ack', signed, async (request, reply) => {
    const device = requireDevice(request);
    const body = CommandAckRequestSchema.parse(jsonBody(request.rawBody));
    await ingest.ackCommand(device, UuidSchema.parse(request.params.id), body);
    return reply.send(await ingest.envelope(device, clock.now()));
  });

  // --- §5.3.5 incident upsert ----------------------------------------------
  // PUT per §5.3.5, and POST too: the SIM800L HTTP stack (AT+HTTPACTION) can
  // only GET/POST/HEAD, and Appendix E.1 (proven hardware) overrides §5.3. The
  // method is part of the signed canonical string, so each is signed as sent.
  scope.route<{ Params: { eventId: string } }>({
    method: ['PUT', 'POST'],
    url: '/incidents/:eventId',
    ...signed,
    handler: async (request, reply) => {
    const device = requireDevice(request);
    const eventId = UuidSchema.parse(request.params.eventId);
    const body = IncidentUpsertRequestSchema.parse(jsonBody(request.rawBody));

    const result = await ingest.upsertIncident(device, eventId, body);

    return reply.send({
      serverTime: result.serverTime,
      incidentId: result.incidentId,
      state: result.state,
      decision: result.decision,
      serverQuestion: result.serverQuestion,
      questionSentAt: toIso(result.questionSentAt),
      responseDeadlineAt: toIso(result.responseDeadlineAt),
      configVersion: result.configVersion,
      commands: result.commands,
    });
    },
  });

  // --- §5.3.6 control poll, decision ack, local button ----------------------
  scope.get<{ Params: { eventId: string } }>(
    '/incidents/:eventId/control',
    signed,
    async (request, reply) => {
      const device = requireDevice(request);
      return reply.send(await ingest.control(device, UuidSchema.parse(request.params.eventId)));
    },
  );

  scope.post<{ Params: { eventId: string; commandId: string } }>(
    '/incidents/:eventId/control/:commandId/ack',
    signed,
    async (request, reply) => {
      const device = requireDevice(request);
      const body = IncidentControlAckRequestSchema.parse(jsonBody(request.rawBody));
      return reply.send(
        await ingest.ackControl(
          device,
          UuidSchema.parse(request.params.eventId),
          UuidSchema.parse(request.params.commandId),
          body,
        ),
      );
    },
  );

  scope.post<{ Params: { eventId: string } }>(
    '/incidents/:eventId/local-response',
    signed,
    async (request, reply) => {
      const device = requireDevice(request);
      const body = LocalResponseRequestSchema.parse(jsonBody(request.rawBody));
      return reply.send(
        await ingest.localResponse(device, UuidSchema.parse(request.params.eventId), body),
      );
    },
  );

  // --- §5.3.7 notification reporting ---------------------------------------
  scope.post<{ Params: { eventId: string } }>(
    '/incidents/:eventId/notifications',
    signed,
    async (request, reply) => {
      const device = requireDevice(request);
      const body = DeviceNotificationReportSchema.parse(jsonBody(request.rawBody));
      return reply.send(
        await ingest.reportNotification(device, UuidSchema.parse(request.params.eventId), body),
      );
    },
  );

  // --- §4.4.3 image session / chunks / complete ----------------------------
  scope.post<{ Params: { eventId: string } }>(
    '/incidents/:eventId/image/session',
    signed,
    async (request, reply) => {
      const device = requireDevice(request);
      const eventId = UuidSchema.parse(request.params.eventId);
      const body = OpenImageSessionRequestSchema.parse(jsonBody(request.rawBody));

      const incident = await scope.prisma.incident.findFirst({
        where: { id: eventId, deviceId: device.id },
        select: { id: true },
      });
      if (!incident) throw new AppError('NOT_FOUND', 'Incident not found for this device.');

      const session = await images.openSession({ incidentId: eventId, ...body });
      return reply.send({ ...session, serverTime: toIsoRequired(clock.now()) });
    },
  );

  // PUT per §4.4.3, POST for the SIM800L (see the incident upsert above).
  scope.route<{ Params: { sessionId: string; offset: string } }>({
    method: ['PUT', 'POST'],
    url: '/images/:sessionId/chunks/:offset',
    ...signed,
    handler: async (request, reply) => {
      const device = requireDevice(request);
      const sessionId = UuidSchema.parse(request.params.sessionId);

      const offset = Number(request.params.offset);
      if (!Number.isInteger(offset) || offset < 0) {
        throw new AppError('VALIDATION_FAILED', 'Chunk offset must be a non-negative integer.');
      }

      // Ownership: the session must belong to an incident from this device.
      const session = await scope.prisma.incidentImage.findFirst({
        where: { id: sessionId, incident: { deviceId: device.id } },
        select: { id: true },
      });
      if (!session) throw new AppError('NOT_FOUND', 'Upload session not found.');

      const result = await images.appendChunk({
        sessionId,
        offset,
        chunk: request.rawBody ?? Buffer.alloc(0),
      });

      return reply.send({ ...result, serverTime: toIsoRequired(clock.now()) });
    },
  });

  scope.post<{ Params: { sessionId: string } }>(
    '/images/:sessionId/complete',
    signed,
    async (request, reply) => {
      const device = requireDevice(request);
      const sessionId = UuidSchema.parse(request.params.sessionId);

      const owned = await scope.prisma.incidentImage.findFirst({
        where: { id: sessionId, incident: { deviceId: device.id } },
        select: { id: true },
      });
      if (!owned) throw new AppError('NOT_FOUND', 'Upload session not found.');

      const result = await images.complete(sessionId);

      // §5.6.5: the integrity hash covers the photo, so it is recomputed once
      // the photo is verified.
      await incidents.refreshIntegrityHash(result.incidentId, result.sha256);

      return reply.send({
        state: result.state,
        sha256: result.sha256,
        bytes: result.bytes,
        reason: result.reason,
        serverTime: toIsoRequired(clock.now()),
      });
    },
  );
};
