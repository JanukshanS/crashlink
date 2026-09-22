/**
 * FR-NOT-04 push notifications (FCM HTTP v1), with the network stubbed.
 *
 * What matters here: a push is only ever an attention aid, a dead token is
 * dropped rather than retried forever, and nothing is sent when no service
 * account is configured (the default in development and tests).
 */
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPushSender, FcmPushSender, NoopPushSender } from '../src/lib/push.js';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const account = { project_id: 'crashlink-test', client_email: 'push@crashlink.iam.gserviceaccount.com', private_key: privateKey };

/** Just the two Prisma calls the sender makes. */
const fakePrisma = (tokens: string[]) => {
  const deleted: string[] = [];
  return {
    deleted,
    client: {
      pushToken: {
        findMany: async () => tokens.map((token) => ({ token })),
        deleteMany: async ({ where }: { where: { token: string } }) => {
          deleted.push(where.token);
          return { count: 1 };
        },
      },
    },
  };
};

const oauthResponse = () => new Response(JSON.stringify({ access_token: 'test-token', expires_in: 3600 }), { status: 200 });

describe('FR-NOT-04 push sender', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends one high-priority message per device on the emergency channel', async () => {
    const prisma = fakePrisma(['tok-a', 'tok-b']);
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('oauth2') ? oauthResponse() : new Response('{}', { status: 200 }),
    );

    const sender = new FcmPushSender(prisma.client as never, account);
    const accepted = await sender.sendToUser('driver-1', {
      title: 'Are you safe?',
      body: 'Possible collision on Scooter 1 - tap to answer',
      data: { type: 'INCIDENT_QUESTION', incidentId: 'evt-1' },
      channelId: 'emergency',
    });

    expect(accepted).toBe(2);
    const sends = fetchMock.mock.calls.filter(([url]) => String(url).includes('messages:send'));
    expect(sends).toHaveLength(2);
    const message = JSON.parse(String(sends[0]![1].body)).message;
    expect(message).toMatchObject({
      token: 'tok-a',
      android: { priority: 'HIGH', notification: { channel_id: 'emergency' } },
      // The tap handler routes on these, exactly as the socket payload does.
      data: { type: 'INCIDENT_QUESTION', incidentId: 'evt-1' },
    });
    // The OAuth token is fetched once and reused for the second device.
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('oauth2'))).toHaveLength(1);
  });

  it('drops a token Firebase says is gone, and keeps the others', async () => {
    const prisma = fakePrisma(['dead-token', 'live-token']);
    fetchMock.mockImplementation(async (url: string, init?: { body?: string }) => {
      if (String(url).includes('oauth2')) return oauthResponse();
      return String(init?.body).includes('dead-token')
        ? new Response(JSON.stringify({ error: { status: 'UNREGISTERED' } }), { status: 404 })
        : new Response('{}', { status: 200 });
    });

    const sender = new FcmPushSender(prisma.client as never, account);
    const accepted = await sender.sendToUser('owner-1', { title: 't', body: 'b', data: {} });

    expect(accepted).toBe(1);
    expect(prisma.deleted).toEqual(['dead-token']);
  });

  it('never throws when Firebase is unreachable', async () => {
    const prisma = fakePrisma(['tok']);
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('oauth2')) return oauthResponse();
      throw new Error('network down');
    });

    const sender = new FcmPushSender(prisma.client as never, account);
    await expect(sender.sendToUser('user', { title: 't', body: 'b', data: {} })).resolves.toBe(0);
  });

  it('is a no-op without a service account, and accepts base64 or raw JSON', () => {
    expect(createPushSender({} as never, undefined)).toBeInstanceOf(NoopPushSender);
    expect(createPushSender({} as never, 'not-json')).toBeInstanceOf(NoopPushSender);
    expect(createPushSender({} as never, JSON.stringify(account))).toBeInstanceOf(FcmPushSender);
    expect(createPushSender({} as never, Buffer.from(JSON.stringify(account)).toString('base64'))).toBeInstanceOf(FcmPushSender);
  });
});
