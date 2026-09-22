/**
 * DeviceIngestService - all device business logic, transport-agnostic (§4.3).
 *
 * The HTTP routes under `/d/v1` are thin wrappers around these methods. A
 * future MQTT subscriber (§5.3.12) calls exactly the same functions, which is
 * the whole reason the logic does not live in the route handlers: the protocol
 * may change, the rules must not.
 *
 * Nothing here knows about Fastify, requests, or signatures - authentication
 * has already happened by the time a method is called, and the caller passes
 * the authenticated device in.
 */
import type { Device, Prisma, PrismaClient } from '@prisma/client';
import {
  type CommandAckRequest,
  type DeviceCommandDto,
  type DeviceNotificationReport,
  type HeartbeatRequest,
  type IncidentUpsertRequest,
  DeviceConfigSchema,
} from '@crashlink/contracts';
import { addSeconds, toIsoRequired, type Clock } from '../../lib/time.js';
import { distanceIncrement, isPlausibleCoordinate } from '../../lib/geo.js';
import type { RealtimeEmitter } from '../../lib/realtime.js';
import { ensureNotification, recordAttempt } from '../notifications/service.js';
import {
  IncidentService,
  stampIntegrityHash,
  toIncidentSummary,
  type IncidentUpsertResult,
} from '../incidents/service.js';
import { DecisionService } from '../incidents/decision.service.js';
import { buildBikeSummary, bikeInclude, buildHealthDto, deviceOnlineState } from '../bikes/service.js';
import { AppError } from '../../lib/errors.js';

const OPEN_RENTAL_STATES = ['PENDING_SYNC', 'ACTIVE', 'ENDING_SYNC'] as const;

/**
 * Bytes of commands per response. The envelope (serverTime, configVersion,
 * nextIntervalSec and the keys) is ~110 B, so this keeps a response < 1 KB.
 */
const COMMAND_BYTE_BUDGET = 880;

export interface DeviceIngestDeps {
  prisma: PrismaClient;
  clock: Clock;
  realtime: RealtimeEmitter;
  incidents: IncidentService;
  decisions: DecisionService;
  responseWindowSec: number;
}

/** What every device response carries (§5.3.3). */
export interface DeviceEnvelope {
  serverTime: string;
  configVersion: number;
  commands: DeviceCommandDto[];
}

export interface HeartbeatOutcome extends DeviceEnvelope {
  nextIntervalSec: number;
  acceptedFixes: number;
  rejectedFixes: number;
  incidents: IncidentUpsertResult[];
}

/** The bike a device is paired to, with the owner needed for scoping. */
type PairedBike = Prisma.BikeGetPayload<{ include: { owner: { select: { id: true } } } }>;

export class DeviceIngestService {
  constructor(private readonly deps: DeviceIngestDeps) {}

  // -------------------------------------------------------------------------
  // Shared plumbing
  // -------------------------------------------------------------------------

  private async pairedBike(deviceId: string): Promise<PairedBike | null> {
    return this.deps.prisma.bike.findFirst({
      where: { deviceId },
      include: { owner: { select: { id: true } } },
    });
  }

  /**
   * §5.3.4 - pending commands ride on every response, in creation order, and
   * repeat until acked or expired. Marking them DELIVERED is what lets
   * `/admin/health` show a queue that is moving.
   */
  private async pendingCommands(deviceId: string, at: Date): Promise<DeviceCommandDto[]> {
    const candidates = await this.deps.prisma.deviceCommand.findMany({
      where: {
        deviceId,
        status: { in: ['QUEUED', 'DELIVERED'] },
        expiresAt: { gt: at },
      },
      orderBy: { createdAt: 'asc' },
      take: 5,
    });

    /**
     * Appendix E.1.3: keep `/d/v1` responses under 1 KB - they drain slowly at
     * 9600 baud and are easy to truncate. A full SET_CONFIG alone is ~500 B, so
     * a fixed count cannot guarantee that; commands are added in order until
     * the byte budget is spent. The first always goes, so the queue always
     * moves, and the rest follow on the next response - order is never broken.
     */
    const commands: typeof candidates = [];
    let used = 0;
    for (const command of candidates) {
      const size = Buffer.byteLength(
        JSON.stringify({ id: command.id, type: command.type, payload: command.payload }),
      );
      if (commands.length > 0 && used + size > COMMAND_BYTE_BUDGET) break;
      commands.push(command);
      used += size + 1;
    }

    if (commands.length > 0) {
      await this.deps.prisma.deviceCommand.updateMany({
        where: { id: { in: commands.map((command) => command.id) }, status: 'QUEUED' },
        data: { status: 'DELIVERED', deliveredAt: at },
      });
    }

    return commands.map((command) => ({
      id: command.id,
      type: command.type,
      payload: command.payload as Record<string, unknown>,
    }));
  }

  async envelope(device: Device, at: Date): Promise<DeviceEnvelope> {
    return {
      serverTime: toIsoRequired(at),
      configVersion: device.configVersion,
      commands: await this.pendingCommands(device.id, at),
    };
  }

  /** §5.3.2 `GET /d/v1/time` - unsigned clock bootstrap. */
  serverTime(): { serverTime: string; epoch: number } {
    const now = this.deps.clock.now();
    return { serverTime: toIsoRequired(now), epoch: Math.floor(now.getTime() / 1000) };
  }

  // -------------------------------------------------------------------------
  // §5.3.3 Heartbeat / telemetry
  // -------------------------------------------------------------------------

  /**
   * Ingests one heartbeat: health, ignition, GPS fixes, and any INFO/SECURITY
   * events the device batched.
   *
   * Per §5.3.3 an invalid item is rejected on its own, never failing the whole
   * request - a single bad fix must not cost us the health update and the
   * events in the same payload.
   */
  async heartbeat(device: Device, body: HeartbeatRequest): Promise<HeartbeatOutcome> {
    const { prisma, clock } = this.deps;
    const now = clock.now();

    const bike = await this.pairedBike(device.id);

    const config = DeviceConfigSchema.safeParse(device.config);
    const demoMode = config.success ? config.data.demoMode : false;

    await prisma.device.update({
      where: { id: device.id },
      data: {
        lastSeenAt: now,
        lastHealth: body.health as unknown as Prisma.InputJsonValue,
        lastMode: body.state.mode,
        firmwareVersion: body.fw ?? device.firmwareVersion,
        appliedConfigVersion: body.configVersion,
      },
    });

    if (!bike) {
      // A provisioned but unpaired device still gets time and commands; there
      // is simply nowhere to file its telemetry.
      return {
        ...(await this.envelope(device, now)),
        nextIntervalSec: config.success ? config.data.telemetryOffSec : 60,
        acceptedFixes: 0,
        rejectedFixes: body.fixes.length,
        incidents: [],
      };
    }

    const openRental = await prisma.rental.findFirst({
      where: { bikeId: bike.id, state: { in: [...OPEN_RENTAL_STATES] } },
    });

    // --- ignition (FR-RENT-06 inputs) --------------------------------------
    for (const event of body.ignitionEvents) {
      await prisma.ignitionEvent
        .create({
          data: {
            bikeId: bike.id,
            rentalId: openRental?.id ?? null,
            state: event.state,
            changedAt: new Date(event.t),
            receivedAt: now,
          },
        })
        // @@unique([bikeId, changedAt]) - a resent batch is not an error.
        .catch(() => undefined);
    }

    /**
     * §5.6.5 riding/parked time walks ignition_events, so a state change must
     * leave an event even when the device did not batch one explicitly - the
     * `ignition` field on every heartbeat is itself a report of the current
     * state. Without this, a device that only sends `ignition` (as the
     * simulator does) would show zero riding time forever.
     *
     * When the batch already contained this change, the (bikeId, changedAt)
     * unique constraint drops the duplicate.
     */
    if (body.ignition.state !== bike.ignition && body.ignition.state !== 'UNKNOWN') {
      await prisma.ignitionEvent
        .create({
          data: {
            bikeId: bike.id,
            rentalId: openRental?.id ?? null,
            state: body.ignition.state,
            changedAt: body.ignition.changedAt ? new Date(body.ignition.changedAt) : now,
            receivedAt: now,
          },
        })
        .catch(() => undefined);
    }

    // --- fixes (§5.3.3 validation, §5.6.5 distance) ------------------------
    let accepted = 0;
    let rejected = 0;
    let lastFix: { lat: number; lon: number; fixAt: Date; speedKph: number | null; source: 'GPS' | 'DEMO' } | null = null;

    let anchor =
      openRental?.lastDistanceLat != null && openRental.lastDistanceLon != null && openRental.lastDistanceAt
        ? { lat: openRental.lastDistanceLat, lon: openRental.lastDistanceLon, at: openRental.lastDistanceAt }
        : null;
    let distanceAdded = 0;

    const sorted = [...body.fixes].sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime());

    for (const fix of sorted) {
      // §5.3.3: DEMO-sourced fixes are only accepted when the device config
      // says demoMode - otherwise a simulator could move a real bike.
      if (fix.src === 'DEMO' && !demoMode) {
        rejected += 1;
        continue;
      }
      if (!isPlausibleCoordinate(fix.lat, fix.lon)) {
        rejected += 1;
        continue;
      }

      const fixAt = new Date(fix.t);

      const created = await prisma.locationSample
        .create({
          data: {
            bikeId: bike.id,
            rentalId: openRental?.id ?? null,
            fixAt,
            receivedAt: now,
            lat: fix.lat,
            lon: fix.lon,
            speedKph: fix.spd ?? null,
            hdop: fix.hdop ?? null,
            satellites: fix.sat ?? null,
            valid: fix.valid,
            source: fix.src,
          },
        })
        // @@unique([bikeId, fixAt]) - de-duplicated, as §5.6.4 requires.
        .catch(() => null);

      if (!created) continue;
      accepted += 1;

      if (fix.valid) {
        lastFix = { lat: fix.lat, lon: fix.lon, fixAt, speedKph: fix.spd ?? null, source: fix.src };
      }

      // FR-RENT-05: only an ACTIVE rental accumulates distance.
      if (openRental?.state === 'ACTIVE') {
        const metres = distanceIncrement(anchor, {
          lat: fix.lat,
          lon: fix.lon,
          fixAt,
          hdop: fix.hdop ?? null,
          valid: fix.valid,
        });
        if (metres !== null) distanceAdded += metres;
        if (fix.valid) anchor = { lat: fix.lat, lon: fix.lon, at: fixAt };
      }
    }

    if (openRental?.state === 'ACTIVE' && anchor) {
      await prisma.rental.update({
        where: { id: openRental.id },
        data: {
          distanceMeters: { increment: distanceAdded },
          lastDistanceLat: anchor.lat,
          lastDistanceLon: anchor.lon,
          lastDistanceAt: anchor.at,
        },
      });
    }

    // --- bike snapshot -----------------------------------------------------
    const ignitionChanged = body.ignition.state !== bike.ignition;
    await prisma.bike.update({
      where: { id: bike.id },
      data: {
        ignition: body.ignition.state,
        ignitionChangedAt: ignitionChanged
          ? body.ignition.changedAt
            ? new Date(body.ignition.changedAt)
            : now
          : bike.ignitionChangedAt,
        ...(lastFix
          ? {
              lastLat: lastFix.lat,
              lastLon: lastFix.lon,
              lastFixAt: lastFix.fixAt,
              lastSpeedKph: lastFix.speedKph,
              lastLocationSource: lastFix.source,
            }
          : {}),
      },
    });

    // --- batched events (§5.3.3: INFO events become incidents) -------------
    const incidents: IncidentUpsertResult[] = [];
    for (const event of body.events) {
      const result = await this.deps.incidents.upsertFromDevice({
        deviceId: device.id,
        bikeId: bike.id,
        ownerId: bike.ownerId,
        isDemo: bike.isDemo,
        body: {
          schema: 1,
          eventId: event.eventId,
          rentalId: openRental?.id ?? null,
          assignmentVersion: body.assignmentVersion ?? null,
          type: event.type,
          occurredAt: event.t,
          timeSource: body.timeSource,
          ignition: body.ignition.state,
          preEventSpeedKph: null,
          evidence: { simulated: false, ...event.evidence } as never,
          sensorWindow: null,
          location: {
            kind: event.lat != null && event.lon != null ? 'LIVE' : 'UNAVAILABLE',
            lat: event.lat ?? null,
            lon: event.lon ?? null,
            fixAt: event.t,
            ageSecondsAtEvent: 0,
            src: 'GPS',
          },
          photoStatus: 'NOT_REQUESTED',
          localDecision: null,
        },
      });
      incidents.push(result);
    }

    // FR-INC-10: the device is talking again, so close any open dead-man alert.
    await this.clearDeadManIncidents(bike.id, now);

    await this.emitBikeUpdate(bike.id, bike.ownerId, now);

    const nextIntervalSec = config.success
      ? body.ignition.state === 'ON'
        ? config.data.telemetryOnSec
        : config.data.telemetryOffSec
      : 60;

    return {
      ...(await this.envelope(device, now)),
      nextIntervalSec,
      acceptedFixes: accepted,
      rejectedFixes: rejected,
      incidents,
    };
  }

  /** FR-INC-10: auto-close the dead-man incident when the device returns. */
  private async clearDeadManIncidents(bikeId: string, at: Date): Promise<void> {
    await this.deps.prisma.incident.updateMany({
      where: {
        bikeId,
        type: 'DEVICE_OFFLINE_DURING_RENTAL',
        state: { in: ['OPEN', 'ESCALATED'] },
      },
      data: { state: 'CLOSED', closedAt: at, ownerNote: 'Device started reporting again.' },
    });
  }

  /** §5.5 `bike.updated` / `device.status` to the owner's room. */
  async emitBikeUpdate(bikeId: string, ownerId: string, at: Date): Promise<void> {
    const bike = await this.deps.prisma.bike.findUnique({
      where: { id: bikeId },
      include: bikeInclude(OPEN_RENTAL_STATES),
    });
    if (!bike) return;

    const openIncidentCount = await this.deps.prisma.incident.count({
      where: { bikeId, state: { in: ['OPEN', 'AWAITING_RESPONSE', 'ESCALATED'] } },
    });

    this.deps.realtime.toOwner(
      ownerId,
      'bike.updated',
      buildBikeSummary(bike as never, openIncidentCount, at),
    );

    if (bike.device) {
      this.deps.realtime.toOwner(ownerId, 'device.status', {
        bikeId,
        online: deviceOnlineState(bike.device.lastSeenAt, bike.ignition === 'ON', bike.device.config, at),
        lastSeenAt: bike.device.lastSeenAt ? toIsoRequired(bike.device.lastSeenAt) : null,
        health: buildHealthDto(bike.device),
      });
    }
  }

  // -------------------------------------------------------------------------
  // §5.3.4 Commands
  // -------------------------------------------------------------------------

  /**
   * A command ack. Idempotent (§5.3.4): the device resends acks it is not sure
   * landed, and an already-acked command must not be re-applied.
   */
  async ackCommand(device: Device, commandId: string, body: CommandAckRequest): Promise<void> {
    const { prisma, clock } = this.deps;
    const now = clock.now();

    const command = await prisma.deviceCommand.findFirst({
      where: { id: commandId, deviceId: device.id },
    });
    if (!command) throw new AppError('NOT_FOUND', 'Command not found for this device.');
    if (command.status === 'ACKED' || command.status === 'REJECTED') return;

    const applied = body.result === 'APPLIED';

    await prisma.deviceCommand.update({
      where: { id: command.id },
      data: {
        status: applied ? 'ACKED' : 'REJECTED',
        ackedAt: now,
        result: body as unknown as Prisma.InputJsonValue,
      },
    });

    if (!applied) return;

    // FR-RENT-03: the device has persisted the snapshot in NVS, and only now
    // does the rental become ACTIVE. This is the whole point of PENDING_SYNC.
    if (command.type === 'SET_ASSIGNMENT') {
      const payload = command.payload as { rentalId?: string };
      if (payload.rentalId) {
        const rental = await prisma.rental.findUnique({ where: { id: payload.rentalId } });
        if (rental && rental.state === 'PENDING_SYNC') {
          const updated = await prisma.rental.update({
            where: { id: rental.id },
            data: { state: 'ACTIVE', deviceAckAt: now, startedAt: now },
          });
          this.emitRental(updated);
        }
      }
    }

    // FR-RENT-04: the bike has let go of the rider's details.
    if (command.type === 'CLEAR_ASSIGNMENT') {
      const payload = command.payload as { rentalId?: string };
      if (payload.rentalId) {
        const rental = await prisma.rental.findUnique({ where: { id: payload.rentalId } });
        if (rental && rental.state === 'ENDING_SYNC') {
          const updated = await prisma.rental.update({
            where: { id: rental.id },
            data: { state: 'ENDED', endedAt: now },
          });
          await prisma.bike.update({ where: { id: rental.bikeId }, data: { status: 'AVAILABLE' } });
          this.emitRental(updated);
        }
      }
    }

    if (command.type === 'SET_CONFIG') {
      await prisma.device.update({
        where: { id: device.id },
        data: { appliedConfigVersion: body.configVersion ?? device.configVersion },
      });
    }
  }

  private emitRental(rental: {
    id: string;
    bikeId: string;
    state: string;
    ownerId: string;
    driverId: string;
    startedAt: Date | null;
    endedAt: Date | null;
    deviceAckAt: Date | null;
  }): void {
    const payload = {
      id: rental.id,
      bikeId: rental.bikeId,
      state: rental.state,
      startedAt: rental.startedAt ? toIsoRequired(rental.startedAt) : null,
      endedAt: rental.endedAt ? toIsoRequired(rental.endedAt) : null,
      deviceAckAt: rental.deviceAckAt ? toIsoRequired(rental.deviceAckAt) : null,
    } as never;

    this.deps.realtime.toOwner(rental.ownerId, 'rental.updated', payload);
    this.deps.realtime.toUser(rental.driverId, 'rental.updated', payload);
  }

  // -------------------------------------------------------------------------
  // §5.3.5 / §5.3.6 Incidents
  // -------------------------------------------------------------------------

  async upsertIncident(
    device: Device,
    eventId: string,
    body: IncidentUpsertRequest,
  ): Promise<IncidentUpsertResult & DeviceEnvelope> {
    const { clock } = this.deps;
    const now = clock.now();

    const bike = await this.pairedBike(device.id);
    if (!bike) throw new AppError('DEVICE_NOT_PAIRED', 'This device is not paired to a bike.');

    if (body.eventId !== eventId) {
      throw new AppError('VALIDATION_FAILED', 'eventId in the path and body must match.');
    }

    const result = await this.deps.incidents.upsertFromDevice({
      deviceId: device.id,
      bikeId: bike.id,
      ownerId: bike.ownerId,
      isDemo: bike.isDemo,
      body,
    });

    // D8: a device reporting a decision it made offline reconciles into the
    // existing incident - never a second CONTACT_SMS.
    if (!result.created && body.localDecision) {
      await this.deps.decisions.reconcileLocalDecision({
        incidentId: eventId,
        decision: body.localDecision.decision,
        source: body.localDecision.source,
        decidedAt: new Date(body.localDecision.decidedAt),
      });
    }

    await this.emitBikeUpdate(bike.id, bike.ownerId, now);

    const refreshed = await this.deps.prisma.incident.findUniqueOrThrow({
      where: { id: eventId },
      select: {
        state: true,
        decision: true,
        serverQuestion: true,
        questionSentAt: true,
        responseDeadlineAt: true,
        quarantined: true,
      },
    });

    return {
      ...result,
      state: refreshed.state,
      decision: refreshed.decision,
      serverQuestion: refreshed.serverQuestion,
      questionSentAt: refreshed.questionSentAt,
      responseDeadlineAt: refreshed.responseDeadlineAt,
      quarantined: refreshed.quarantined,
      ...(await this.envelope(device, now)),
    };
  }

  /** §5.3.6 control poll (every 3 s while AWAITING_RESPONSE). */
  async control(device: Device, eventId: string) {
    const now = this.deps.clock.now();

    const incident = await this.deps.prisma.incident.findFirst({
      where: { id: eventId, deviceId: device.id },
      select: { id: true },
    });
    if (!incident) throw new AppError('NOT_FOUND', 'Incident not found for this device.');

    const state = await this.deps.decisions.controlState(eventId);
    if (!state) throw new AppError('NOT_FOUND', 'Incident not found.');

    return { serverTime: toIsoRequired(now), ...state };
  }

  /**
   * §5.3.6 - the device confirms it applied the decision, which is what lets
   * the UI say "Synced with bike" instead of guessing.
   */
  async ackControl(
    device: Device,
    eventId: string,
    commandId: string,
    body: { applied: boolean; localState: string },
  ): Promise<DeviceEnvelope> {
    const { prisma, clock } = this.deps;
    const now = clock.now();

    const command = await prisma.deviceCommand.findFirst({
      where: { id: commandId, deviceId: device.id, incidentId: eventId },
    });
    if (!command) throw new AppError('NOT_FOUND', 'Decision command not found for this incident.');

    if (command.status !== 'ACKED') {
      await prisma.deviceCommand.update({
        where: { id: command.id },
        data: {
          status: body.applied ? 'ACKED' : 'REJECTED',
          ackedAt: now,
          result: body as unknown as Prisma.InputJsonValue,
        },
      });
    }

    if (body.applied) {
      await prisma.driverResponse.updateMany({
        where: { incidentId: eventId, accepted: true, syncedToDeviceAt: null },
        data: { syncedToDeviceAt: now },
      });
    }

    return this.envelope(device, now);
  }

  /** §5.3.6 local button press on the bike (D5, D6, D9). */
  async localResponse(
    device: Device,
    eventId: string,
    body: { choice: 'SAFE' | 'HELP'; deviceTime: string; idempotencyKey: string },
  ): Promise<{ accepted: boolean; decision: string; reason?: string }> {
    const incident = await this.deps.prisma.incident.findFirst({
      where: { id: eventId, deviceId: device.id },
      select: { id: true },
    });

    // D9: a local Safe with no active incident "is logged as informational and
    // never pre-resolves a future incident". Logged, then nothing else happens.
    if (!incident) {
      await this.deps.prisma.auditEvent.create({
        data: {
          actorType: 'DEVICE',
          actorId: device.id,
          action: 'DEVICE_LOCAL_RESPONSE_NO_INCIDENT',
          targetType: 'DEVICE',
          targetId: device.id,
          meta: { eventId, choice: body.choice, deviceTime: body.deviceTime },
          createdAt: this.deps.clock.now(),
        },
      });
      return { accepted: false, decision: 'NOT_APPLICABLE', reason: 'NO_ACTIVE_INCIDENT' };
    }

    const outcome = await this.deps.decisions.respond({
      incidentId: eventId,
      choice: body.choice,
      source: 'DEVICE_BUTTON',
      idempotencyKey: body.idempotencyKey,
      deviceTime: new Date(body.deviceTime),
    });

    return {
      accepted: outcome.accepted,
      decision: outcome.decision,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // §5.3.7 Notification reporting
  // -------------------------------------------------------------------------

  /**
   * The bike telling us what its modem actually did. Idempotent on
   * `(eventId, kind, attemptNo, state)`, because the device retries the report
   * itself and must never inflate the attempt history (FR-NOT-01).
   */
  async reportNotification(
    device: Device,
    eventId: string,
    body: DeviceNotificationReport,
  ): Promise<DeviceEnvelope> {
    const { prisma, clock } = this.deps;
    const now = clock.now();

    const incident = await prisma.incident.findFirst({
      where: { id: eventId, deviceId: device.id },
      select: {
        id: true,
        ownerId: true,
        ownerPhoneSnapshot: true,
        contactPhoneSnapshot: true,
        rental: { select: { driverPhoneSnapshot: true } },
      },
    });
    if (!incident) throw new AppError('NOT_FOUND', 'Incident not found for this device.');

    const recipient =
      body.kind === 'OWNER_SMS'
        ? incident.ownerPhoneSnapshot
        : body.kind === 'CONTACT_SMS' || body.kind === 'CONTACT_CALL'
          ? incident.contactPhoneSnapshot
          : body.kind === 'DRIVER_SMS'
            ? (incident.rental?.driverPhoneSnapshot ?? null)
            : null;

    const state = await prisma.$transaction(async (tx) => {
      const { id } = await ensureNotification(tx, {
        incidentId: incident.id,
        kind: body.kind,
        recipientPhone: recipient,
        at: now,
      });

      const result = await recordAttempt(tx, {
        notificationId: id,
        attemptNo: body.attemptNo,
        state: body.state,
        detail: body.detail ?? null,
        deviceTime: new Date(body.deviceTime),
      });

      return result.state;
    });

    this.deps.realtime.toOwner(incident.ownerId, 'notification.updated', {
      incidentId: incident.id,
      kind: body.kind,
      state,
    } as never);

    return this.envelope(device, now);
  }

  /** Used by the dead-man worker; kept here so all device rules live together. */
  async raiseDeadManIncident(input: {
    bikeId: string;
    ownerId: string;
    deviceId: string | null;
    rentalId: string;
    driverId: string;
    isDemo: boolean;
    silentSince: Date;
  }): Promise<string | null> {
    const { prisma, clock } = this.deps;
    const now = clock.now();

    const already = await prisma.incident.findFirst({
      where: {
        bikeId: input.bikeId,
        rentalId: input.rentalId,
        type: 'DEVICE_OFFLINE_DURING_RENTAL',
        state: { in: ['OPEN', 'ESCALATED'] },
      },
      select: { id: true },
    });
    if (already) return null;

    const rental = await prisma.rental.findUnique({ where: { id: input.rentalId } });

    const incident = await prisma.$transaction(async (tx) => {
      const created = await tx.incident.create({
        data: {
          // §5.6.4: server-generated ids are only for this type and app SOS.
          id: crypto.randomUUID(),
          bikeId: input.bikeId,
          deviceId: input.deviceId,
          rentalId: input.rentalId,
          driverId: input.driverId,
          ownerId: input.ownerId,
          type: 'DEVICE_OFFLINE_DURING_RENTAL',
          category: 'SECURITY',
          state: 'OPEN',
          occurredAt: input.silentSince,
          receivedAt: now,
          timeSource: 'SERVER_SYNC',
          locationKind: 'UNAVAILABLE',
          evidence: {
            simulated: false,
            silentSinceAt: toIsoRequired(input.silentSince),
            note: 'Server-side dead-man rule (FR-INC-10). The bike stopped reporting.',
          } as Prisma.InputJsonValue,
          // FR-INC-09/FR-INC-10: no driver question, and the bike cannot send
          // an SMS - it is the thing that went quiet. Owner push only.
          serverQuestion: false,
          decision: 'NOT_APPLICABLE',
          ownerPhoneSnapshot: rental?.ownerPhoneSnapshot ?? null,
          driverNameSnapshot: rental?.driverNameSnapshot ?? null,
          contactNameSnapshot: rental?.contactNameSnapshot ?? null,
          contactPhoneSnapshot: rental?.contactPhoneSnapshot ?? null,
          isDemo: input.isDemo,
        },
        include: { bike: { select: { label: true } } },
      });

      await ensureNotification(tx, {
        incidentId: created.id,
        kind: 'OWNER_PUSH',
        state: 'REQUESTED',
        at: now,
      });

      // FR-INC-11: server-raised incidents are hashed exactly like device ones.
      await stampIntegrityHash(tx, created.id, null);

      return created;
    });

    this.deps.realtime.toOwner(input.ownerId, 'incident.created', toIncidentSummary(incident as never));

    return incident.id;
  }

  /**
   * FR-RENT-04: "ENDED on ack (or after 10 min with warning)".
   *
   * A bike that is off or out of coverage cannot ack CLEAR_ASSIGNMENT, and
   * leaving the rental in ENDING_SYNC would pin the bike and the rider forever
   * (FR-RENT-02). After the timeout it ends - with the warning recorded, so the
   * owner can see the bike never confirmed it released the rider's details.
   * The CLEAR_ASSIGNMENT stays queued: the bike still clears when it returns.
   */
  async endStaleRentals(timeoutSec: number): Promise<number> {
    const { prisma, clock } = this.deps;
    const now = clock.now();

    const stale = await prisma.rental.findMany({
      where: {
        state: 'ENDING_SYNC',
        endRequestedAt: { lte: new Date(now.getTime() - timeoutSec * 1000) },
      },
    });

    let endedCount = 0;
    for (const rental of stale) {
      const ended = await prisma.$transaction(async (tx) => {
        // Claim it: an ack arriving in the same instant must not be overwritten.
        const claimed = await tx.rental.updateMany({
          where: { id: rental.id, state: 'ENDING_SYNC' },
          data: { state: 'ENDED', endedAt: now },
        });
        if (claimed.count === 0) return null;

        await tx.bike.update({ where: { id: rental.bikeId }, data: { status: 'AVAILABLE' } });
        await tx.auditEvent.create({
          data: {
            actorType: 'SYSTEM',
            action: 'RENTAL_END_TIMEOUT',
            targetType: 'RENTAL',
            targetId: rental.id,
            meta: {
              warning: 'Ended without the bike confirming CLEAR_ASSIGNMENT',
              timeoutSec,
              endRequestedAt: rental.endRequestedAt?.toISOString() ?? null,
            },
            createdAt: now,
          },
        });

        return tx.rental.findUniqueOrThrow({ where: { id: rental.id } });
      });

      if (ended) {
        endedCount += 1;
        this.emitRental(ended);
      }
    }

    return endedCount;
  }

  /** Command TTL helper shared with the expiry worker (§5.3.4). */
  static expiryFor(type: string, at: Date, defaultTtlSec: number, decisionTtlSec: number): Date {
    return addSeconds(at, type === 'INCIDENT_DECISION' ? decisionTtlSec : defaultTtlSec);
  }
}
