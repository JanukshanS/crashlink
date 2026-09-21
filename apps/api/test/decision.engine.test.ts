/**
 * §5.3.6 decision engine - rules D1-D10, with a controllable clock.
 *
 * These are the tests the whole product rests on: whether the emergency contact
 * is texted exactly once, and whether a rider who answers in time is believed.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assignRental,
  auth,
  createReadyDriver,
  createTestContext,
  destroyTestContext,
  pairDeviceToBike,
  registerUser,
  resetDatabase,
  type TestContext,
  type TestUser,
} from './helpers.js';
import { createDevice, incidentBody, signedRequest, type TestDevice } from './deviceHelpers.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await destroyTestContext(ctx);
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  ctx.clock.set('2026-09-21T06:30:00.000Z');
  ctx.realtime.clear();
});

interface Scene {
  owner: TestUser;
  driver: TestUser;
  device: TestDevice;
  bikeId: string;
  rentalId: string;
  assignmentVersion: number;
}

/**
 * An ACTIVE rental on a paired device - the precondition for any EMERGENCY
 * incident to produce a driver question (§5.3.5 step 4).
 */
const setupActiveRental = async (): Promise<Scene> => {
  const owner = await registerUser(ctx, 'OWNER');
  const driver = await createReadyDriver(ctx, 'Ravi Kumar');
  const device = await createDevice(ctx);
  const bikeId = await pairDeviceToBike(ctx, owner, device);

  const { body } = await assignRental(ctx, owner, bikeId, driver.id);
  const rentalId = body.id as string;
  const assignmentVersion = body.assignmentVersion as number;

  await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/rentals/${rentalId}/force-activate`,
    headers: auth(owner.accessToken),
    payload: { confirm: true },
  });

  return { owner, driver, device, bikeId, rentalId, assignmentVersion };
};

/** Reports a confirmed collision from the bike and returns the incident id. */
const reportCollision = async (
  scene: Scene,
  overrides: Parameters<typeof incidentBody>[1] = {},
): Promise<{ eventId: string; body: Record<string, unknown> }> => {
  const eventId = (overrides.eventId as string) ?? randomUUID();

  const body = incidentBody(ctx, {
    eventId,
    rentalId: scene.rentalId,
    assignmentVersion: scene.assignmentVersion,
    ...overrides,
  });

  const response = await ctx.app.inject(
    signedRequest(ctx, scene.device, {
      method: 'PUT',
      path: `/d/v1/incidents/${eventId}`,
      body,
    }),
  );

  if (response.statusCode !== 200) {
    throw new Error(`incident upsert failed: ${response.statusCode} ${response.body}`);
  }

  return { eventId, body: response.json() };
};

const contactSmsCount = async (incidentId: string): Promise<number> =>
  ctx.prisma.notification.count({ where: { incidentId, kind: 'CONTACT_SMS' } });

describe('Incident upsert creates the question (§5.3.5, FR-INC-02)', () => {
  it('opens a 60 s window from questionSentAt, on server time', async () => {
    const scene = await setupActiveRental();
    const { eventId, body } = await reportCollision(scene);

    expect(body.state).toBe('AWAITING_RESPONSE');
    expect(body.decision).toBe('PENDING');
    expect(body.serverQuestion).toBe(true);

    // The window is exactly RESPONSE_WINDOW_SEC from the server's clock.
    const sentAt = new Date(body.questionSentAt as string).getTime();
    const deadline = new Date(body.responseDeadlineAt as string).getTime();
    expect(deadline - sentAt).toBe(ctx.config.RESPONSE_WINDOW_SEC * 1000);
    expect(sentAt).toBe(ctx.clock.now().getTime());

    // No contact SMS yet - nobody has been escalated to (D3).
    expect(await contactSmsCount(eventId)).toBe(0);

    // The rider is asked, and the owner is told (§5.5).
    const prompt = await ctx.prisma.notification.findFirst({
      where: { incidentId: eventId, kind: 'DRIVER_PROMPT' },
    });
    expect(prompt?.state).toBe('REQUESTED');
    expect(ctx.realtime.byName('incident.question')).toHaveLength(1);
    expect(ctx.realtime.byName('incident.created')).toHaveLength(1);
  });

  it('never questions SECURITY or INFO incidents (FR-INC-09)', async () => {
    const scene = await setupActiveRental();

    for (const type of ['PARKED_BIKE_FALL', 'POSSIBLE_TOWING', 'POSSIBLE_POTHOLE']) {
      const { eventId, body } = await reportCollision(scene, { type, ignition: 'OFF' });

      expect(body.serverQuestion, type).toBe(false);
      expect(body.responseDeadlineAt, type).toBeNull();
      expect(await contactSmsCount(eventId)).toBe(0);

      const incident = await ctx.prisma.incident.findUniqueOrThrow({ where: { id: eventId } });
      expect(incident.state, type).toBe(type === 'POSSIBLE_POTHOLE' ? 'INFO_RECORDED' : 'OPEN');
    }
  });
});

describe('D1 - a response inside the window wins', () => {
  it('SAFE at 30 s is accepted and resolves the incident', async () => {
    const scene = await setupActiveRental();
    const { eventId } = await reportCollision(scene);

    // Half-way through the 60 s window.
    ctx.clock.advanceSeconds(30);

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/incidents/${eventId}/responses`,
      headers: auth(scene.driver.accessToken),
      payload: { choice: 'SAFE', idempotencyKey: randomUUID() },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ accepted: true, decision: 'SAFE', deviceSync: 'PENDING' });

    const incident = await ctx.prisma.incident.findUniqueOrThrow({ where: { id: eventId } });
    expect(incident.decision).toBe('SAFE');
    expect(incident.decisionSource).toBe('APP');
    expect(incident.state).toBe('RESOLVED_SAFE');
    expect(incident.decidedAt?.toISOString()).toBe(ctx.clock.now().toISOString());

    // D3: SAFE never texts the emergency contact.
    expect(await contactSmsCount(eventId)).toBe(0);

    // The bike is told, so it can stop its own escalation timer (§5.3.6).
    const command = await ctx.prisma.deviceCommand.findFirst({
      where: { incidentId: eventId, type: 'INCIDENT_DECISION' },
    });
    expect(command?.payload).toMatchObject({ eventId, decision: 'SAFE' });

    // Even after the deadline passes, SAFE stands - the worker must not undo it.
    ctx.clock.advanceSeconds(120);
    await ctx.app.workers.runOnce('deadline');

    const after = await ctx.prisma.incident.findUniqueOrThrow({ where: { id: eventId } });
    expect(after.decision).toBe('SAFE');
    expect(await contactSmsCount(eventId)).toBe(0);
  });

  it('HELP escalates immediately and requests exactly one CONTACT_SMS (D3)', async () => {
    const scene = await setupActiveRental();
    const { eventId } = await reportCollision(scene);

    ctx.clock.advanceSeconds(5);

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/incidents/${eventId}/responses`,
      headers: auth(scene.driver.accessToken),
      payload: { choice: 'HELP', idempotencyKey: randomUUID() },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().decision).toBe('HELP');

    const incident = await ctx.prisma.incident.findUniqueOrThrow({ where: { id: eventId } });
    expect(incident.state).toBe('ESCALATED');
    expect(incident.decidedAt?.toISOString()).toBe(ctx.clock.now().toISOString());

    expect(await contactSmsCount(eventId)).toBe(1);

    const contact = await ctx.prisma.notification.findFirstOrThrow({
      where: { incidentId: eventId, kind: 'CONTACT_SMS' },
    });
    // The backend never sends SMS (pinned decision) - it only records the ask.
    expect(contact.state).toBe('REQUESTED');
    // §5.7.3: only the masked number is stored on the notification.
    expect(contact.recipientMasked).toMatch(/^\+94•••••\d{4}$/);

    // Running the deadline worker afterwards must not add a second one.
    ctx.clock.advanceSeconds(120);
    await ctx.app.workers.runOnce('deadline');
    expect(await contactSmsCount(eventId)).toBe(1);
  });

  it('is idempotent on the response key', async () => {
    const scene = await setupActiveRental();
    const { eventId } = await reportCollision(scene);

    const key = randomUUID();
    const payload = { choice: 'SAFE', idempotencyKey: key };

    const first = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/incidents/${eventId}/responses`,
      headers: auth(scene.driver.accessToken),
      payload,
    });
    const second = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/incidents/${eventId}/responses`,
      headers: auth(scene.driver.accessToken),
      payload,
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(await ctx.prisma.driverResponse.count({ where: { incidentId: eventId } })).toBe(1);
  });
});

describe('D2 / D3 - timeout escalates exactly once', () => {
  it('creates one CONTACT_SMS under 20 concurrent polls and a concurrent late SAFE', async () => {
    const scene = await setupActiveRental();
    const { eventId } = await reportCollision(scene);

    // Past the deadline: every claimant below is now racing for the same row.
    ctx.clock.advanceSeconds(ctx.config.RESPONSE_WINDOW_SEC + 1);

    const polls = Array.from({ length: 20 }, () =>
      ctx.app.inject(
        signedRequest(ctx, scene.device, {
          method: 'GET',
          path: `/d/v1/incidents/${eventId}/control`,
        }),
      ),
    );

    const lateSafe = ctx.app.inject({
      method: 'POST',
      url: `/api/v1/incidents/${eventId}/responses`,
      headers: auth(scene.driver.accessToken),
      payload: { choice: 'SAFE', idempotencyKey: randomUUID() },
    });

    const workerPass = ctx.app.workers.runOnce('deadline');

    const [pollResults, safeResult] = await Promise.all([
      Promise.all(polls),
      lateSafe,
      workerPass,
    ]);

    // The single most important assertion in the codebase.
    expect(await contactSmsCount(eventId)).toBe(1);

    const incident = await ctx.prisma.incident.findUniqueOrThrow({ where: { id: eventId } });
    expect(incident.decision).toBe('TIMEOUT');
    expect(incident.decisionSource).toBe('SERVER_TIMER');
    expect(incident.state).toBe('ESCALATED');

    // Every poll agrees on the outcome; none of them saw a different decision.
    for (const poll of pollResults) {
      expect(poll.statusCode).toBe(200);
      expect(poll.json().decision).toBe('TIMEOUT');
    }

    // D1/D7: the late SAFE lost and was told so.
    expect(safeResult.statusCode).toBe(409);
    expect(safeResult.json().code).toBe('TOO_LATE');

    // Exactly one decision command for the bike, too.
    expect(
      await ctx.prisma.deviceCommand.count({
        where: { incidentId: eventId, type: 'INCIDENT_DECISION' },
      }),
    ).toBe(1);
  });

  it('stores a late SAFE with accepted=false and reason TOO_LATE (D7)', async () => {
    const scene = await setupActiveRental();
    const { eventId } = await reportCollision(scene);

    ctx.clock.advanceSeconds(ctx.config.RESPONSE_WINDOW_SEC + 5);
    await ctx.app.workers.runOnce('deadline');

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/incidents/${eventId}/responses`,
      headers: auth(scene.driver.accessToken),
      payload: { choice: 'SAFE', idempotencyKey: randomUUID() },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: 'TOO_LATE',
      details: { decision: 'TIMEOUT' },
    });

    // The response is kept, not discarded: the timeline has to be able to say
    // "Safe received after emergency SMS submission".
    const stored = await ctx.prisma.driverResponse.findFirstOrThrow({
      where: { incidentId: eventId },
    });
    expect(stored.accepted).toBe(false);
    expect(stored.rejectReason).toBe('TOO_LATE');
    expect(stored.choice).toBe('SAFE');

    // ...and the owner's detail view shows exactly that.
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/incidents/${eventId}`,
      headers: auth(scene.owner.accessToken),
    });
    const timeline = detail.json().timeline as { event: string; text: string }[];
    expect(timeline.some((entry) => entry.event === 'RESPONSE_REJECTED')).toBe(true);
    expect(detail.json().responses[0]).toMatchObject({ accepted: false, reason: 'TOO_LATE' });
  });

  it('does not time out before the deadline', async () => {
    const scene = await setupActiveRental();
    const { eventId } = await reportCollision(scene);

    ctx.clock.advanceSeconds(ctx.config.RESPONSE_WINDOW_SEC - 1);
    await ctx.app.workers.runOnce('deadline');

    const incident = await ctx.prisma.incident.findUniqueOrThrow({ where: { id: eventId } });
    expect(incident.decision).toBe('PENDING');
    expect(await contactSmsCount(eventId)).toBe(0);
  });
});

describe('D5 - the bike button', () => {
  it('accepts a local SAFE inside the window and marks it DEVICE_BUTTON', async () => {
    const scene = await setupActiveRental();
    const { eventId } = await reportCollision(scene);

    ctx.clock.advanceSeconds(10);

    const response = await ctx.app.inject(
      signedRequest(ctx, scene.device, {
        method: 'POST',
        path: `/d/v1/incidents/${eventId}/local-response`,
        body: {
          choice: 'SAFE',
          deviceTime: ctx.clock.now().toISOString(),
          idempotencyKey: randomUUID(),
        },
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ accepted: true, decision: 'SAFE' });

    const incident = await ctx.prisma.incident.findUniqueOrThrow({ where: { id: eventId } });
    expect(incident.decision).toBe('SAFE');
    expect(incident.decisionSource).toBe('DEVICE_BUTTON');
  });

  it('refuses a local SAFE once HELP or TIMEOUT has landed', async () => {
    const scene = await setupActiveRental();
    const { eventId } = await reportCollision(scene);

    ctx.clock.advanceSeconds(ctx.config.RESPONSE_WINDOW_SEC + 1);
    await ctx.app.workers.runOnce('deadline');

    const response = await ctx.app.inject(
      signedRequest(ctx, scene.device, {
        method: 'POST',
        path: `/d/v1/incidents/${eventId}/local-response`,
        body: {
          choice: 'SAFE',
          deviceTime: ctx.clock.now().toISOString(),
          idempotencyKey: randomUUID(),
        },
      }),
    );

    expect(response.json()).toMatchObject({ accepted: false, decision: 'TIMEOUT' });
    expect(await contactSmsCount(eventId)).toBe(1);
  });

  it('D9 - a local SAFE with no active incident never pre-resolves anything', async () => {
    const scene = await setupActiveRental();

    const response = await ctx.app.inject(
      signedRequest(ctx, scene.device, {
        method: 'POST',
        path: `/d/v1/incidents/${randomUUID()}/local-response`,
        body: {
          choice: 'SAFE',
          deviceTime: ctx.clock.now().toISOString(),
          idempotencyKey: randomUUID(),
        },
      }),
    );

    expect(response.json()).toMatchObject({ accepted: false, reason: 'NO_ACTIVE_INCIDENT' });

    // A later incident still asks the question.
    const { body } = await reportCollision(scene);
    expect(body.serverQuestion).toBe(true);
    expect(body.decision).toBe('PENDING');
  });
});

describe('D8 - offline-fallback reconciliation', () => {
  it('does not create a second CONTACT_SMS when the device escalated offline', async () => {
    const scene = await setupActiveRental();
    const eventId = randomUUID();

    // The bike could not reach us, ran its own 60 s timer and texted the
    // contact. It reports all of that when GPRS returns.
    const first = await ctx.app.inject(
      signedRequest(ctx, scene.device, {
        method: 'PUT',
        path: `/d/v1/incidents/${eventId}`,
        body: incidentBody(ctx, {
          eventId,
          rentalId: scene.rentalId,
          assignmentVersion: scene.assignmentVersion,
          localDecision: {
            decision: 'OFFLINE_FALLBACK',
            source: 'DEVICE_OFFLINE_TIMER',
            decidedAt: ctx.clock.now().toISOString(),
          },
        }),
      }),
    );

    expect(first.statusCode).toBe(200);
    // §5.3.5: a device that already decided gets no server question.
    expect(first.json().serverQuestion).toBe(false);
    expect(first.json().decision).toBe('OFFLINE_FALLBACK');
    expect(await contactSmsCount(eventId)).toBe(1);

    // It re-reports the same event (retries are expected over GPRS).
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const retry = await ctx.app.inject(
        signedRequest(ctx, scene.device, {
          method: 'PUT',
          path: `/d/v1/incidents/${eventId}`,
          body: incidentBody(ctx, {
            eventId,
            rentalId: scene.rentalId,
            assignmentVersion: scene.assignmentVersion,
            localDecision: {
              decision: 'OFFLINE_FALLBACK',
              source: 'DEVICE_OFFLINE_TIMER',
              decidedAt: ctx.clock.now().toISOString(),
            },
          }),
        }),
      );
      expect(retry.statusCode).toBe(200);
    }

    expect(await contactSmsCount(eventId)).toBe(1);
    expect(await ctx.prisma.incident.count({ where: { id: eventId } })).toBe(1);
  });

  it('keeps the server decision but records both facts when they disagree', async () => {
    const scene = await setupActiveRental();
    const { eventId } = await reportCollision(scene);

    // The server decided SAFE at 20 s.
    ctx.clock.advanceSeconds(20);
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/incidents/${eventId}/responses`,
      headers: auth(scene.driver.accessToken),
      payload: { choice: 'SAFE', idempotencyKey: randomUUID() },
    });

    // The bike never heard that, and escalated on its own timer.
    ctx.clock.advanceSeconds(45);
    const reconcile = await ctx.app.inject(
      signedRequest(ctx, scene.device, {
        method: 'PUT',
        path: `/d/v1/incidents/${eventId}`,
        body: incidentBody(ctx, {
          eventId,
          rentalId: scene.rentalId,
          assignmentVersion: scene.assignmentVersion,
          localDecision: {
            decision: 'OFFLINE_FALLBACK',
            source: 'DEVICE_OFFLINE_TIMER',
            decidedAt: ctx.clock.now().toISOString(),
          },
        }),
      }),
    );

    expect(reconcile.statusCode).toBe(200);

    // D8: the server's SAFE stands and no second contact SMS is invented.
    const incident = await ctx.prisma.incident.findUniqueOrThrow({ where: { id: eventId } });
    expect(incident.decision).toBe('SAFE');
    expect(await contactSmsCount(eventId)).toBe(0);
  });
});

describe('FR-INC-01 / FR-INC-06 - idempotency and quarantine', () => {
  it('a duplicate PUT returns the same incident and creates nothing new', async () => {
    const scene = await setupActiveRental();
    const eventId = randomUUID();

    const first = await reportCollision(scene, { eventId });
    const second = await reportCollision(scene, { eventId });
    const third = await reportCollision(scene, { eventId });

    expect(second.body.incidentId).toBe(first.body.incidentId);
    expect(third.body.incidentId).toBe(first.body.incidentId);
    expect(second.body.responseDeadlineAt).toBe(first.body.responseDeadlineAt);

    expect(await ctx.prisma.incident.count()).toBe(1);
    // One prompt, one owner push - never duplicated (FR-INC-01).
    expect(await ctx.prisma.notification.count({ where: { incidentId: eventId } })).toBe(2);
    expect(ctx.realtime.byName('incident.question')).toHaveLength(1);
  });

  it('quarantines an assignmentVersion mismatch with serverQuestion=false', async () => {
    const scene = await setupActiveRental();

    const { eventId, body } = await reportCollision(scene, {
      // The bike still believes it is on a rental that has since been replaced.
      assignmentVersion: scene.assignmentVersion + 99,
    });

    expect(body.serverQuestion).toBe(false);
    expect(body.responseDeadlineAt).toBeNull();

    const incident = await ctx.prisma.incident.findUniqueOrThrow({ where: { id: eventId } });
    // Stored and flagged, never dropped (FR-INC-06).
    expect(incident.quarantined).toBe(true);
    expect(incident.quarantineReason).toContain('No rental for assignmentVersion');
    expect(incident.rentalId).toBeNull();
    expect(incident.state).toBe('OPEN');

    // No question and no snapshots: we cannot say whose ride this was.
    expect(await ctx.prisma.notification.count({ where: { incidentId: eventId, kind: 'DRIVER_PROMPT' } })).toBe(0);
    expect(incident.contactPhoneSnapshot).toBeNull();

    // The owner is still told (FR-INC-06 "owner alerted").
    expect(await ctx.prisma.notification.count({ where: { incidentId: eventId, kind: 'OWNER_PUSH' } })).toBe(1);
  });

  it('quarantines a rentalId that does not match the resolved rental', async () => {
    const scene = await setupActiveRental();

    const { eventId } = await reportCollision(scene, { rentalId: randomUUID() });

    const incident = await ctx.prisma.incident.findUniqueOrThrow({ where: { id: eventId } });
    expect(incident.quarantined).toBe(true);
    expect(incident.quarantineReason).toContain('Device reported rental');
  });
});

describe('§5.3.6 control polling and device sync', () => {
  it('reports PENDING before the deadline and the decision after', async () => {
    const scene = await setupActiveRental();
    const { eventId } = await reportCollision(scene);

    const before = await ctx.app.inject(
      signedRequest(ctx, scene.device, {
        method: 'GET',
        path: `/d/v1/incidents/${eventId}/control`,
      }),
    );
    expect(before.json()).toMatchObject({ decision: 'PENDING', commandId: null });
    expect(before.json().responseDeadlineAt).not.toBeNull();

    ctx.clock.advanceSeconds(20);
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/incidents/${eventId}/responses`,
      headers: auth(scene.driver.accessToken),
      payload: { choice: 'SAFE', idempotencyKey: randomUUID() },
    });

    const after = await ctx.app.inject(
      signedRequest(ctx, scene.device, {
        method: 'GET',
        path: `/d/v1/incidents/${eventId}/control`,
      }),
    );
    expect(after.json().decision).toBe('SAFE');
    expect(after.json().commandId).not.toBeNull();

    // Acking the decision is what lets the UI claim "Synced with bike".
    const commandId = after.json().commandId as string;
    const ack = await ctx.app.inject(
      signedRequest(ctx, scene.device, {
        method: 'POST',
        path: `/d/v1/incidents/${eventId}/control/${commandId}/ack`,
        body: { applied: true, localState: 'RESOLVED' },
      }),
    );
    expect(ack.statusCode).toBe(200);

    const response = await ctx.prisma.driverResponse.findFirstOrThrow({
      where: { incidentId: eventId, accepted: true },
    });
    expect(response.syncedToDeviceAt).not.toBeNull();
  });
});
