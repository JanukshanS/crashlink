/**
 * The device incident state machine of §4.5.1, as the firmware implements it.
 *
 *   MONITORING -> FALL_CANDIDATE -> INCIDENT -> AWAITING_RESPONSE
 *                                -> RESOLVED | ESCALATED -> REARM_WAIT -> MONITORING
 *
 * The simulator runs the real thing rather than a script, because the point is
 * to prove the *server* behaves when a real device does these steps in this
 * order - including the 3 s control poll and the offline fallback timer.
 */
import { randomUUID } from 'node:crypto';
import type { DeviceClient } from './client.js';

export type DeviceState =
  | 'MONITORING'
  | 'FALL_CANDIDATE'
  | 'INCIDENT'
  | 'AWAITING_RESPONSE'
  | 'RESOLVED'
  | 'ESCALATE'
  | 'ESCALATED'
  | 'REARM_WAIT';

export interface MachineConfig {
  /** §5.3.9 - the pinned safety values. */
  fallConfirmSec: number;
  responseWindowSec: number;
  controlPollSec: number;
  deadlineGraceSec: number;
  rearmUprightSec: number;
}

export const DEFAULT_MACHINE_CONFIG: MachineConfig = {
  fallConfirmSec: 10,
  responseWindowSec: 60,
  controlPollSec: 3,
  deadlineGraceSec: 15,
  rearmUprightSec: 5,
};

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface IncidentEvidence {
  fallenDurationMs: number;
  peakAccelerationG: number;
  peakRotationDps: number;
  maxTiltDeg: number;
  simulated: boolean;
}

export interface Fix {
  lat: number;
  lon: number;
  speedKph: number;
}

/** Colombo / Malabe, where the demo route runs. */
export const COLOMBO: Fix = { lat: 6.9147, lon: 79.9729, speedKph: 0 };

export interface RunContext {
  client: DeviceClient;
  config: MachineConfig;
  log: (message: string) => void;
  /** Scale factor so a 60 s window can be watched in a demo, or run in full. */
  timeScale: number;
}

/** The assignment the device holds in NVS after SET_ASSIGNMENT (§5.3.4). */
export interface Assignment {
  rentalId: string;
  assignmentVersion: number;
  bikeLabel: string;
  ownerPhone: string;
  driverName: string;
  contactName: string;
  contactPhone: string;
}

export class DeviceMachine {
  state: DeviceState = 'MONITORING';
  assignment: Assignment | null = null;
  configVersion = 1;

  /**
   * Called whenever the persisted state changes, so the caller can write it to
   * the NVS stand-in. §5.3.4: persist first, ack second - never the reverse.
   */
  onPersist: ((state: { assignment: Assignment | null; configVersion: number }) => void) | null = null;

  constructor(private readonly ctx: RunContext) {}

  private persist(): void {
    this.onPersist?.({ assignment: this.assignment, configVersion: this.configVersion });
  }

  private scaled(seconds: number): number {
    return Math.max(0, Math.round(seconds * 1000 * this.ctx.timeScale));
  }

  /**
   * §5.3.4: every response carries commands. Applying SET_ASSIGNMENT is what
   * gives the bike the numbers it will text, and only then may it ack.
   */
  applyCommands(commands: { id: string; type: string; payload: Record<string, unknown> }[]): Promise<void>[] {
    return commands.map(async (command) => {
      switch (command.type) {
        case 'SET_ASSIGNMENT': {
          this.assignment = command.payload as unknown as Assignment;
          this.ctx.log(
            `  applied SET_ASSIGNMENT v${this.assignment.assignmentVersion} ` +
              `(rider ${this.assignment.driverName}, contact ${this.assignment.contactName})`,
          );
          // §5.3.4: persisted in NVS first, acked second - never the other way
          // round, or a reboot between the two would leave the bike carrying a
          // rider it cannot name.
          this.persist();
          await this.ctx.client.ackCommand(command.id, 'APPLIED', {
            assignmentVersion: this.assignment.assignmentVersion,
          });
          break;
        }
        case 'CLEAR_ASSIGNMENT': {
          this.ctx.log('  applied CLEAR_ASSIGNMENT');
          this.assignment = null;
          this.persist();
          await this.ctx.client.ackCommand(command.id, 'APPLIED');
          break;
        }
        case 'SET_CONFIG': {
          const payload = command.payload as { configVersion?: number };
          this.configVersion = payload.configVersion ?? this.configVersion;
          this.ctx.log(`  applied SET_CONFIG v${this.configVersion}`);
          this.persist();
          await this.ctx.client.ackCommand(command.id, 'APPLIED', { configVersion: this.configVersion });
          break;
        }
        case 'INCIDENT_DECISION': {
          // Acked through the incident-specific route (§5.3.6), handled by the
          // control loop, so nothing to do here.
          break;
        }
        default: {
          this.ctx.log(`  ignoring unknown command ${command.type}`);
          await this.ctx.client.ackCommand(command.id, 'REJECTED', { reason: 'UNKNOWN_TYPE' });
        }
      }
    });
  }

  /** §5.3.3 one heartbeat. */
  async heartbeat(input: {
    ignition: 'ON' | 'OFF';
    fixes?: Fix[];
    events?: { eventId: string; type: string; evidence: Record<string, unknown>; lat?: number; lon?: number }[];
    mode?: string;
    activeEventId?: string | null;
    demoSource?: boolean;
  }): Promise<number> {
    const now = this.ctx.client.now();

    const body = {
      schema: 1,
      deviceTime: now.toISOString(),
      timeSource: 'SERVER_SYNC',
      fw: '1.0.0-sim',
      assignmentVersion: this.assignment?.assignmentVersion ?? null,
      configVersion: this.configVersion,
      ignition: { state: input.ignition, changedAt: now.toISOString() },
      ignitionEvents: [],
      fixes: (input.fixes ?? []).map((fix, index) => ({
        t: new Date(now.getTime() - (input.fixes!.length - index) * 1000).toISOString(),
        lat: fix.lat,
        lon: fix.lon,
        spd: fix.speedKph,
        hdop: 1.1,
        sat: 8,
        valid: true,
        src: input.demoSource ? 'DEMO' : 'GPS',
      })),
      events: (input.events ?? []).map((event) => ({
        eventId: event.eventId,
        type: event.type,
        t: now.toISOString(),
        evidence: event.evidence,
        lat: event.lat ?? null,
        lon: event.lon ?? null,
      })),
      health: {
        csq: 17,
        gprs: true,
        gpsFix: true,
        sats: 8,
        hdop: 1.1,
        cameraLink: true,
        // M10: battery is never measured.
        batteryV: null,
        freeHeap: 81234,
        uptimeS: Math.floor(process.uptime()),
        queuedJobs: 0,
        demoMode: true,
        resetReason: 'POWERON',
      },
      state: { mode: input.mode ?? 'MONITORING', activeEventId: input.activeEventId ?? null },
    };

    const response = await this.ctx.client.request<{ nextIntervalSec: number }>(
      'POST',
      '/d/v1/heartbeat',
      body,
    );

    if (response.status !== 200) {
      throw new Error(`heartbeat failed: ${response.status} ${JSON.stringify(response.body)}`);
    }

    await Promise.all(this.applyCommands(response.commands));
    return response.body.nextIntervalSec ?? 10;
  }

  /**
   * §4.5.1 FALL_CANDIDATE -> INCIDENT: the tilt has to persist for
   * `fallConfirmSec` (10 s, fixed) before anything is reported. This is the
   * single most important delay in the product - it is what stops a dropped
   * bike on a kickstand from calling someone's mother.
   */
  async confirmFall(): Promise<void> {
    this.state = 'FALL_CANDIDATE';
    this.ctx.log(`  FALL_CANDIDATE - waiting ${this.ctx.config.fallConfirmSec}s to confirm`);
    await sleep(this.scaled(this.ctx.config.fallConfirmSec));
    this.state = 'INCIDENT';
    this.ctx.log('  fall confirmed');
  }

  /** §5.3.5 report the incident. */
  async reportIncident(input: {
    eventId: string;
    type: string;
    ignition: 'ON' | 'OFF';
    preEventSpeedKph: number | null;
    evidence: IncidentEvidence;
    fix?: Fix | null;
    localDecision?: { decision: string; source: string; decidedAt: string } | null;
    photoStatus?: string;
  }): Promise<{ status: number; body: Record<string, unknown> }> {
    const now = this.ctx.client.now();
    const fix = input.fix ?? COLOMBO;

    const body = {
      schema: 1,
      eventId: input.eventId,
      rentalId: this.assignment?.rentalId ?? null,
      assignmentVersion: this.assignment?.assignmentVersion ?? null,
      type: input.type,
      occurredAt: now.toISOString(),
      timeSource: 'SERVER_SYNC',
      ignition: input.ignition,
      preEventSpeedKph: input.preEventSpeedKph,
      evidence: input.evidence,
      sensorWindow: {
        hz: 5,
        t0: new Date(now.getTime() - 5000).toISOString(),
        a: [1.0, 1.1, input.evidence.peakAccelerationG, 0.9],
        g: [5, 40, input.evidence.peakRotationDps, 12],
        tilt: [3, 20, input.evidence.maxTiltDeg, input.evidence.maxTiltDeg],
        spd: [input.preEventSpeedKph ?? 0, 8.5, 2, 0],
      },
      location: {
        kind: 'LIVE',
        lat: fix.lat,
        lon: fix.lon,
        fixAt: now.toISOString(),
        ageSecondsAtEvent: 2,
        src: 'GPS',
      },
      photoStatus: input.photoStatus ?? 'PENDING',
      localDecision: input.localDecision ?? null,
      recipients: this.assignment
        ? {
            ownerPhoneLast4: this.assignment.ownerPhone.slice(-4),
            contactPhoneLast4: this.assignment.contactPhone.slice(-4),
          }
        : undefined,
    };

    const response = await this.ctx.client.request('PUT', `/d/v1/incidents/${input.eventId}`, body);
    await Promise.all(this.applyCommands(response.commands));

    return { status: response.status, body: response.body as Record<string, unknown> };
  }

  /** §5.3.7 report what the modem actually did with an SMS. */
  async reportSms(
    eventId: string,
    kind: 'OWNER_SMS' | 'CONTACT_SMS',
    state: string,
    attemptNo = 1,
    detail: string | null = null,
  ): Promise<void> {
    await this.ctx.client.request('POST', `/d/v1/incidents/${eventId}/notifications`, {
      schema: 1,
      kind,
      attemptNo,
      state,
      detail,
      deviceTime: this.ctx.client.now().toISOString(),
    });
    this.ctx.log(`  ${kind} -> ${state}${detail ? ` (${detail})` : ''}`);
  }

  /**
   * §5.3.6 D4 - poll control every 3 s while AWAITING_RESPONSE. If no
   * successful control response arrives by `responseDeadlineAt + 15 s`, the
   * device escalates locally and reports it later.
   */
  async awaitDecision(
    eventId: string,
    deadlineAt: Date,
  ): Promise<{ decision: string; commandId: string | null; local: boolean }> {
    this.state = 'AWAITING_RESPONSE';

    const graceAt = new Date(deadlineAt.getTime() + this.ctx.config.deadlineGraceSec * 1000);
    let lastSuccessfulPoll: Date | null = null;

    for (;;) {
      let polled: { decision: string; commandId: string | null } | null = null;

      try {
        const response = await this.ctx.client.request<{ decision: string; commandId: string | null }>(
          'GET',
          `/d/v1/incidents/${eventId}/control`,
        );
        if (response.status === 200) {
          polled = { decision: response.body.decision, commandId: response.body.commandId };
          lastSuccessfulPoll = this.ctx.client.now();
        }
      } catch {
        // Network down: fall through to the grace check below.
      }

      if (polled && polled.decision !== 'PENDING') {
        this.ctx.log(`  server decision: ${polled.decision}`);
        return { ...polled, local: false };
      }

      const now = this.ctx.client.now();

      // D4: offline escalation once the grace period has also passed.
      if (now >= graceAt && (!lastSuccessfulPoll || lastSuccessfulPoll < deadlineAt)) {
        this.ctx.log('  no control response by deadline + grace - escalating locally');
        return { decision: 'OFFLINE_FALLBACK', commandId: null, local: true };
      }

      if (now >= graceAt) {
        this.ctx.log('  deadline + grace passed with server reachable - waiting for its decision');
      }

      await sleep(this.scaled(this.ctx.config.controlPollSec));
    }
  }

  /** §5.3.6 - confirm the decision was applied, so the UI can say "Synced". */
  async ackDecision(eventId: string, commandId: string, localState: string): Promise<void> {
    await this.ctx.client.request(
      'POST',
      `/d/v1/incidents/${eventId}/control/${commandId}/ack`,
      { applied: true, localState },
    );
    this.ctx.log(`  acked decision command (local state ${localState})`);
  }

  /** §5.3.6 - the Safe/SOS button on the bike. */
  async pressButton(eventId: string, choice: 'SAFE' | 'HELP'): Promise<Record<string, unknown>> {
    const response = await this.ctx.client.request('POST', `/d/v1/incidents/${eventId}/local-response`, {
      choice,
      deviceTime: this.ctx.client.now().toISOString(),
      idempotencyKey: randomUUID(),
    });
    this.ctx.log(`  local ${choice} button -> ${JSON.stringify(response.body)}`);
    return response.body as Record<string, unknown>;
  }

  /** §4.5.1 REARM_WAIT: no repeated incidents while the bike stays down (D10). */
  async rearm(): Promise<void> {
    this.state = 'REARM_WAIT';
    this.ctx.log(`  REARM_WAIT - upright for ${this.ctx.config.rearmUprightSec}s`);
    await sleep(this.scaled(this.ctx.config.rearmUprightSec));
    this.state = 'MONITORING';
    this.ctx.log('  MONITORING');
  }
}
