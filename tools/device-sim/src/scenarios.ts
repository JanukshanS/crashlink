/**
 * Scenarios - each one drives the §4.5.1 state machine through a real sequence
 * of signed requests, in the ordering Appendix E.1.4 requires:
 *
 *   1. incident JSON  2. owner SMS  3. contact SMS (if it times out)
 *   4. image upload (last - slowest, least time-critical)
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { COLOMBO, DeviceMachine, sleep, type Fix, type RunContext } from './machine.js';

export interface ScenarioContext extends RunContext {
  machine: DeviceMachine;
  /** Path to fixtures/demo.jpg, uploaded in 2 KB chunks (Appendix E.1.5). */
  imagePath: string;
}

export type ScenarioName =
  | 'heartbeat-loop'
  | 'collision-safe'
  | 'collision-timeout'
  | 'collision-help'
  | 'offline-fallback'
  | 'pothole'
  | 'parked-fall'
  | 'towing'
  | 'dead-man';

export const SCENARIOS: Record<ScenarioName, string> = {
  'heartbeat-loop': 'Telemetry only: heartbeats, GPS trace, command pickup.',
  'collision-safe': 'Confirmed fall, rider presses Safe on the bike inside the window.',
  'collision-timeout': 'Confirmed fall, nobody answers - server TIMEOUT, contact SMS.',
  'collision-help': 'Confirmed fall, rider answers Need help from the app or the bike.',
  'offline-fallback': 'Incident reported late: the bike escalated on its own 60 s timer.',
  pothole: 'INFO event batched on a heartbeat. No SMS, no question.',
  'parked-fall': 'Fall with ignition OFF - SECURITY, owner SMS, no rider question.',
  towing: 'Ignition OFF but moving - SECURITY towing alert.',
  'dead-man': 'Heartbeat once, then go silent so the server raises FR-INC-10.',
};

/** A short GPS trace around Colombo. */
const trace = (steps: number, speedKph = 18): Fix[] =>
  Array.from({ length: steps }, (_, index) => ({
    lat: COLOMBO.lat + index * 0.0009,
    lon: COLOMBO.lon + index * 0.0007,
    speedKph,
  }));

/** Appendix E.1.5: 2 KB chunks, and the whole file capped at 10 KB. */
const CHUNK_BYTES = 2048;

const uploadImage = async (ctx: ScenarioContext, eventId: string): Promise<void> => {
  if (!existsSync(ctx.imagePath)) {
    ctx.log(`  no image at ${ctx.imagePath} - skipping upload`);
    return;
  }

  const image = await readFile(ctx.imagePath);
  const sha256 = createHash('sha256').update(image).digest('hex');

  if (image.length > 10_240) {
    ctx.log(`  WARNING: ${image.length} bytes exceeds the 10 KB budget (Appendix E.1.5)`);
  }

  const session = await ctx.client.request<{ sessionId: string; nextOffset: number }>(
    'POST',
    `/d/v1/incidents/${eventId}/image/session`,
    { schema: 1, bytes: image.length, sha256, chunkSize: CHUNK_BYTES, mime: 'image/jpeg' },
  );

  if (session.status !== 200) {
    ctx.log(`  image session refused: ${session.status} ${JSON.stringify(session.body)}`);
    return;
  }

  const sessionId = session.body.sessionId;
  let offset = session.body.nextOffset;

  ctx.log(`  uploading ${image.length} bytes in ${CHUNK_BYTES}-byte chunks`);

  while (offset < image.length) {
    const chunk = image.subarray(offset, Math.min(offset + CHUNK_BYTES, image.length));
    const put = await ctx.client.request<{ nextOffset: number }>(
      'PUT',
      `/d/v1/images/${sessionId}/chunks/${offset}`,
      undefined,
      { raw: chunk },
    );

    if (put.status !== 200) {
      ctx.log(`  chunk at ${offset} refused: ${put.status} ${JSON.stringify(put.body)}`);
      return;
    }
    offset = put.body.nextOffset;
  }

  const complete = await ctx.client.request<{ state: string; reason: string | null }>(
    'POST',
    `/d/v1/images/${sessionId}/complete`,
    {},
  );

  ctx.log(
    `  image ${complete.body.state}${complete.body.reason ? ` (${complete.body.reason})` : ''}`,
  );
};

/** The common opening: sync the clock and pick up any queued assignment. */
const warmUp = async (ctx: ScenarioContext, ignition: 'ON' | 'OFF' = 'ON'): Promise<void> => {
  await ctx.client.syncClock();
  await ctx.machine.heartbeat({ ignition, fixes: trace(2) });

  if (!ctx.machine.assignment) {
    ctx.log('  no assignment yet - assign a rental to this bike for the full flow');
  }
};

/**
 * The shared EMERGENCY path. `respond` decides what the rider does, which is
 * the only difference between the collision-* scenarios.
 */
const runCollision = async (
  ctx: ScenarioContext,
  respond: (eventId: string, deadlineAt: Date) => Promise<void>,
): Promise<void> => {
  await warmUp(ctx, 'ON');

  const eventId = randomUUID();
  await ctx.machine.confirmFall();

  // 1. Incident JSON first - it is small and the most time-critical.
  const incident = await ctx.machine.reportIncident({
    eventId,
    type: 'POSSIBLE_COLLISION',
    ignition: 'ON',
    preEventSpeedKph: 24,
    evidence: {
      fallenDurationMs: ctx.config.fallConfirmSec * 1000,
      peakAccelerationG: 3.1,
      peakRotationDps: 220,
      maxTiltDeg: 88,
      simulated: true,
    },
  });

  if (incident.status !== 200) {
    throw new Error(`incident upsert failed: ${incident.status} ${JSON.stringify(incident.body)}`);
  }

  ctx.log(`  incident ${incident.body.state} (serverQuestion=${incident.body.serverQuestion})`);

  // 2. Owner SMS. The bike sends it; we only report what the modem said.
  await ctx.machine.reportSms(eventId, 'OWNER_SMS', 'QUEUED');
  await ctx.machine.reportSms(eventId, 'OWNER_SMS', 'AT_SUBMITTED', 1, '+CMGS: 23');

  const deadlineAt = incident.body.responseDeadlineAt
    ? new Date(incident.body.responseDeadlineAt as string)
    : new Date(ctx.client.now().getTime() + ctx.config.responseWindowSec * 1000);

  await respond(eventId, deadlineAt);

  // 4. Image last (Appendix E.1.4).
  await uploadImage(ctx, eventId);
  await ctx.machine.rearm();
};

export const runScenario = async (name: ScenarioName, ctx: ScenarioContext): Promise<void> => {
  const { machine, log } = ctx;

  switch (name) {
    // -----------------------------------------------------------------------
    case 'heartbeat-loop': {
      await ctx.client.syncClock();
      log('Heartbeat loop - Ctrl+C to stop');

      for (let beat = 0; ; beat += 1) {
        const next = await machine.heartbeat({
          ignition: 'ON',
          fixes: trace(3),
          mode: 'MONITORING',
        });
        log(`  beat ${beat + 1}, next in ${next}s`);
        await sleep(next * 1000 * ctx.timeScale);
      }
    }

    // -----------------------------------------------------------------------
    case 'collision-safe': {
      await runCollision(ctx, async (eventId, deadlineAt) => {
        // The rider is fine and presses Safe on the bike after a few seconds.
        await sleep(ctx.timeScale * 5000);
        const result = await machine.pressButton(eventId, 'SAFE');

        if (result.accepted) {
          machine.state = 'RESOLVED';
          log('  RESOLVED locally - no contact SMS');
        }

        // The device still confirms the server's view (§5.3.6).
        const decision = await machine.awaitDecision(eventId, deadlineAt);
        if (decision.commandId) await machine.ackDecision(eventId, decision.commandId, 'RESOLVED');
      });
      break;
    }

    // -----------------------------------------------------------------------
    case 'collision-timeout': {
      await runCollision(ctx, async (eventId, deadlineAt) => {
        log('  nobody answers - polling control until the server decides');
        const decision = await machine.awaitDecision(eventId, deadlineAt);

        if (decision.decision === 'TIMEOUT' || decision.decision === 'HELP') {
          machine.state = 'ESCALATE';
          // 3. Contact SMS, only now that the window has closed.
          await machine.reportSms(eventId, 'CONTACT_SMS', 'QUEUED');
          await machine.reportSms(eventId, 'CONTACT_SMS', 'AT_SUBMITTED', 1, '+CMGS: 24');
          machine.state = 'ESCALATED';
        }

        if (decision.commandId) await machine.ackDecision(eventId, decision.commandId, 'ESCALATED');
      });
      break;
    }

    // -----------------------------------------------------------------------
    case 'collision-help': {
      await runCollision(ctx, async (eventId, deadlineAt) => {
        await sleep(ctx.timeScale * 4000);
        await machine.pressButton(eventId, 'HELP');

        const decision = await machine.awaitDecision(eventId, deadlineAt);

        machine.state = 'ESCALATE';
        await machine.reportSms(eventId, 'CONTACT_SMS', 'QUEUED');
        await machine.reportSms(eventId, 'CONTACT_SMS', 'AT_SUBMITTED', 1, '+CMGS: 25');
        machine.state = 'ESCALATED';

        if (decision.commandId) await machine.ackDecision(eventId, decision.commandId, 'ESCALATED');
      });
      break;
    }

    // -----------------------------------------------------------------------
    case 'offline-fallback': {
      // §4.4.2: GPRS was down, so the bike ran its own timer, texted the
      // contact, and only reports once the network returns. The server must
      // reconcile without creating a second contact SMS (D8).
      await warmUp(ctx, 'ON');

      const eventId = randomUUID();
      await machine.confirmFall();

      log('  GPRS unavailable - running the local 60 s timer');
      await sleep(ctx.timeScale * ctx.config.responseWindowSec * 1000);

      const decidedAt = ctx.client.now().toISOString();
      log('  local timer expired - contact SMS sent by the bike');

      const incident = await machine.reportIncident({
        eventId,
        type: 'POSSIBLE_COLLISION',
        ignition: 'ON',
        preEventSpeedKph: 22,
        evidence: {
          fallenDurationMs: ctx.config.fallConfirmSec * 1000,
          peakAccelerationG: 2.8,
          peakRotationDps: 190,
          maxTiltDeg: 86,
          simulated: true,
        },
        localDecision: { decision: 'OFFLINE_FALLBACK', source: 'DEVICE_OFFLINE_TIMER', decidedAt },
      });

      log(`  reconciled: state=${incident.body.state} decision=${incident.body.decision}`);

      await machine.reportSms(eventId, 'OWNER_SMS', 'AT_SUBMITTED', 1, '+CMGS: 31');
      await machine.reportSms(eventId, 'CONTACT_SMS', 'AT_SUBMITTED', 1, '+CMGS: 32');

      await uploadImage(ctx, eventId);
      await machine.rearm();
      break;
    }

    // -----------------------------------------------------------------------
    case 'pothole': {
      // INFO events ride along on a heartbeat (§5.3.3) - no SMS, no question.
      await warmUp(ctx, 'ON');

      await machine.heartbeat({
        ignition: 'ON',
        fixes: trace(3),
        events: [
          {
            eventId: randomUUID(),
            type: 'POSSIBLE_POTHOLE',
            evidence: { peakAccelerationG: 1.9, durationMs: 180, simulated: true },
            lat: COLOMBO.lat,
            lon: COLOMBO.lon,
          },
        ],
      });

      log('  pothole recorded as INFO - no SMS, no rider question');
      break;
    }

    // -----------------------------------------------------------------------
    case 'parked-fall': {
      // Ignition OFF turns the same fall into SECURITY (§5.3.8).
      await warmUp(ctx, 'OFF');

      const eventId = randomUUID();
      await machine.confirmFall();

      const incident = await machine.reportIncident({
        eventId,
        type: 'PARKED_BIKE_FALL',
        ignition: 'OFF',
        preEventSpeedKph: null,
        evidence: {
          fallenDurationMs: ctx.config.fallConfirmSec * 1000,
          peakAccelerationG: 1.4,
          peakRotationDps: 60,
          maxTiltDeg: 82,
          simulated: true,
        },
        photoStatus: 'PENDING',
      });

      log(`  ${incident.body.state} - owner SMS only, serverQuestion=${incident.body.serverQuestion}`);
      await machine.reportSms(eventId, 'OWNER_SMS', 'AT_SUBMITTED', 1, '+CMGS: 41');

      await uploadImage(ctx, eventId);
      await machine.rearm();
      break;
    }

    // -----------------------------------------------------------------------
    case 'towing': {
      // Ignition OFF, but the bike is moving and has covered ground (§5.3.8).
      await warmUp(ctx, 'OFF');

      const eventId = randomUUID();
      log('  ignition OFF but moving - building the towing case');

      for (let i = 0; i < 3; i += 1) {
        await machine.heartbeat({ ignition: 'OFF', fixes: trace(3, 12) });
        await sleep(ctx.timeScale * 2000);
      }

      const incident = await machine.reportIncident({
        eventId,
        type: 'POSSIBLE_TOWING',
        ignition: 'OFF',
        preEventSpeedKph: 12,
        evidence: {
          fallenDurationMs: 0,
          peakAccelerationG: 0.3,
          peakRotationDps: 10,
          maxTiltDeg: 6,
          simulated: true,
        },
        photoStatus: 'NOT_REQUESTED',
      });

      log(`  ${incident.body.state} - SECURITY alert, no rider question`);
      await machine.reportSms(eventId, 'OWNER_SMS', 'AT_SUBMITTED', 1, '+CMGS: 51');
      break;
    }

    // -----------------------------------------------------------------------
    case 'dead-man': {
      // FR-INC-10: report once, then stop. The server should notice the silence
      // after 90 s (ignition ON) and raise DEVICE_OFFLINE_DURING_RENTAL.
      await warmUp(ctx, 'ON');
      await machine.heartbeat({ ignition: 'ON', fixes: trace(3) });

      log('  going silent now - the server should raise DEVICE_OFFLINE_DURING_RENTAL');
      log(`  expect it after ~90 s of silence (ignition ON); watch the owner's incident list`);
      break;
    }

    default: {
      throw new Error(`Unknown scenario: ${name as string}`);
    }
  }
};
