/**
 * §5.6.5 / FR-RENT-06 riding vs parked time.
 *
 * The clock starts at 2026-09-21T06:30Z = 12:00 in Asia/Colombo, so the local
 * day began 12 hours earlier at 2026-09-20T18:30Z.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ignitionSpans } from '../src/lib/ignition.js';
import { zonedDateKey, zonedDayStart } from '../src/lib/time.js';
import {
  auth,
  createTestContext,
  destroyTestContext,
  pairDeviceToBike,
  registerUser,
  resetDatabase,
  type TestContext,
} from './helpers.js';
import { createDevice, heartbeatBody, signedRequest } from './deviceHelpers.js';

const at = (iso: string) => new Date(iso);

describe('ignitionSpans (§5.6.5 walk)', () => {
  const from = at('2026-09-21T00:00:00Z');
  const to = at('2026-09-21T03:00:00Z');

  it('splits ON->OFF as riding and OFF->ON as parked, with the open span to `to`', () => {
    expect(
      ignitionSpans(
        'OFF',
        [
          { state: 'ON', at: at('2026-09-21T01:00:00Z') },
          { state: 'OFF', at: at('2026-09-21T01:30:00Z') },
        ],
        from,
        to,
      ),
    ).toEqual({ ridingSec: 1800, parkedSec: 9000, unknownSec: 0 });
  });

  it('never counts time before the first known state as riding or parked', () => {
    expect(
      ignitionSpans('UNKNOWN', [{ state: 'ON', at: at('2026-09-21T02:00:00Z') }], from, to),
    ).toEqual({ ridingSec: 3600, parkedSec: 0, unknownSec: 7200 });
  });

  it('ignores events outside the window, including a device clock running ahead', () => {
    expect(
      ignitionSpans(
        'ON',
        [
          { state: 'OFF', at: at('2026-09-20T23:00:00Z') },
          { state: 'OFF', at: at('2026-09-21T09:00:00Z') },
        ],
        from,
        to,
      ),
    ).toEqual({ ridingSec: 10800, parkedSec: 0, unknownSec: 0 });
  });

  it('sorts events, so a batch received out of order still walks correctly', () => {
    expect(
      ignitionSpans(
        'OFF',
        [
          { state: 'OFF', at: at('2026-09-21T02:00:00Z') },
          { state: 'ON', at: at('2026-09-21T01:00:00Z') },
        ],
        from,
        to,
      ),
    ).toEqual({ ridingSec: 3600, parkedSec: 7200, unknownSec: 0 });
  });

  it('returns zeros for an empty or reversed window', () => {
    expect(ignitionSpans('ON', [], to, from)).toEqual({ ridingSec: 0, parkedSec: 0, unknownSec: 0 });
  });
});

describe('zoned day helpers (TZ_DISPLAY = Asia/Colombo, UTC+05:30)', () => {
  it('starts the local day at 18:30Z the previous UTC day', () => {
    expect(zonedDayStart(at('2026-09-21T06:30:00Z'), 'Asia/Colombo').toISOString()).toBe(
      '2026-09-20T18:30:00.000Z',
    );
    // 00:30 local on the 21st is still the 21st locally.
    expect(zonedDayStart(at('2026-09-20T19:00:00Z'), 'Asia/Colombo').toISOString()).toBe(
      '2026-09-20T18:30:00.000Z',
    );
    expect(zonedDateKey(at('2026-09-20T19:00:00Z'), 'Asia/Colombo')).toBe('2026-09-21');
  });
});

// ---------------------------------------------------------------------------
// Integration: heartbeat -> ignition_events -> GET /bikes/:id
// ---------------------------------------------------------------------------

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
});

describe('riding and parked time on bike detail (FR-RENT-06)', () => {
  it('records ignition changes from plain heartbeats and walks them into today\'s totals', async () => {
    const owner = await registerUser(ctx, 'OWNER');
    const device = await createDevice(ctx);
    const bikeId = await pairDeviceToBike(ctx, owner, device);

    const beat = (ignition: 'ON' | 'OFF') =>
      ctx.app.inject(
        signedRequest(ctx, device, { method: 'POST', path: '/d/v1/heartbeat', body: heartbeatBody(ctx, { ignition }) }),
      );

    // Ignition ON at 12:00 local, OFF at 12:30, read at 12:45. The heartbeats
    // carry no explicit ignitionEvents batch - only the `ignition` field.
    expect((await beat('ON')).statusCode).toBe(200);
    // Repeating the same state must not add an event.
    ctx.clock.advanceSeconds(10);
    await beat('ON');

    ctx.clock.set('2026-09-21T07:00:00.000Z');
    await beat('OFF');
    ctx.clock.set('2026-09-21T07:15:00.000Z');

    expect(await ctx.prisma.ignitionEvent.count({ where: { bikeId } })).toBe(2);

    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/bikes/${bikeId}`,
      headers: auth(owner.accessToken),
    });
    expect(detail.statusCode).toBe(200);

    const body = detail.json();
    expect(body.ridingSecToday).toBe(1800);
    expect(body.parkedSecToday).toBe(900);
    // Midnight to 12:00 local: the bike had never reported, so it is unknown.
    expect(body.unknownSecToday).toBe(12 * 3600);
    // "Parked for 15 min".
    expect(body.parkedSinceSec).toBe(900);
  });

  it('carries yesterday\'s last state into today', async () => {
    const owner = await registerUser(ctx, 'OWNER');
    const device = await createDevice(ctx);
    const bikeId = await pairDeviceToBike(ctx, owner, device);

    // Parked since yesterday evening (before local midnight at 18:30Z).
    await ctx.prisma.ignitionEvent.create({
      data: { bikeId, state: 'OFF', changedAt: at('2026-09-20T15:00:00Z') },
    });
    await ctx.prisma.bike.update({
      where: { id: bikeId },
      data: { ignition: 'OFF', ignitionChangedAt: at('2026-09-20T15:00:00Z') },
    });

    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/bikes/${bikeId}`,
      headers: auth(owner.accessToken),
    });

    const body = detail.json();
    expect(body.ridingSecToday).toBe(0);
    expect(body.parkedSecToday).toBe(12 * 3600);
    expect(body.unknownSecToday).toBe(0);
  });
});
