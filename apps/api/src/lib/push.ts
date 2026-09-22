/**
 * Push notifications (FCM HTTP v1).
 *
 * Added on the team's instruction (22 Sep 2026), lifting the MVP's "no FCM"
 * decision: without push, the rider's question only appears while the app is
 * open, and a phone in a pocket never asks "Are you safe?".
 *
 * Honesty (NFR-04): a push is an **attention aid**. Accepting a message means
 * Firebase took it, never that the phone showed it - the app re-fetches the
 * truth from the API when it opens. So a send is recorded as
 * `PROVIDER_ACCEPTED`, and only the app's own ack may become `CLIENT_RECEIVED`.
 *
 * The service account key lives only in `FCM_SERVICE_ACCOUNT_JSON` (raw JSON or
 * base64) on the server. With no key configured, sending is a no-op, so
 * development and tests run unchanged.
 */
import { createSign } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

export interface PushPayload {
  title: string;
  body: string;
  /** Mirrors the §5.5 socket payloads: type + incidentId, read by the tap handler. */
  data: Record<string, string>;
  /** §2.3.4 Android channel: emergency / security / info. */
  channelId?: string;
}

export interface PushSender {
  /** Returns how many of the user's devices Firebase accepted. */
  sendToUser(userId: string, payload: PushPayload): Promise<number>;
}

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

const parseServiceAccount = (raw: string): ServiceAccount => {
  const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  const parsed = JSON.parse(text) as ServiceAccount;
  if (!parsed.project_id || !parsed.client_email || !parsed.private_key) {
    throw new Error('FCM_SERVICE_ACCOUNT_JSON is missing project_id, client_email or private_key');
  }
  return parsed;
};

const base64url = (value: string | Buffer): string =>
  Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Never sends anything - the default when no key is configured. */
export class NoopPushSender implements PushSender {
  async sendToUser(): Promise<number> {
    return 0;
  }
}

export class FcmPushSender implements PushSender {
  private accessToken: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly account: ServiceAccount,
    private readonly log?: { warn: (obj: unknown, msg: string) => void },
  ) {}

  /** Service-account JWT -> OAuth access token, cached until shortly before expiry. */
  private async token(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > Date.now() + 60_000) return this.accessToken.value;

    const now = Math.floor(Date.now() / 1000);
    const claim = {
      iss: this.account.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    };
    const unsigned = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(JSON.stringify(claim))}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(this.account.private_key);
    const assertion = `${unsigned}.${base64url(signature)}`;

    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`FCM token request failed: ${response.status}`);

    const body = (await response.json()) as { access_token: string; expires_in: number };
    this.accessToken = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return body.access_token;
  }

  async sendToUser(userId: string, payload: PushPayload): Promise<number> {
    const tokens = await this.prisma.pushToken.findMany({ where: { userId }, select: { token: true } });
    if (tokens.length === 0) return 0;

    let accessToken: string;
    try {
      accessToken = await this.token();
    } catch (error) {
      this.log?.warn({ err: (error as Error).message }, 'push: could not get an FCM access token');
      return 0;
    }

    const url = `https://fcm.googleapis.com/v1/projects/${this.account.project_id}/messages:send`;
    let accepted = 0;

    for (const { token } of tokens) {
      const message = {
        message: {
          token,
          notification: { title: payload.title, body: payload.body },
          data: payload.data,
          android: {
            priority: 'HIGH',
            // The emergency channel is the loud one (§2.3.4); it exists in the app.
            notification: { channel_id: payload.channelId ?? 'emergency' },
          },
        },
      };

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
          body: JSON.stringify(message),
          signal: AbortSignal.timeout(10_000),
        });

        if (response.ok) {
          accepted++;
          continue;
        }

        const text = await response.text();
        // A phone that uninstalled or reinstalled: drop the token rather than
        // retry it forever (UNREGISTERED / invalid registration token).
        if (response.status === 404 || text.includes('UNREGISTERED') || text.includes('INVALID_ARGUMENT')) {
          await this.prisma.pushToken.deleteMany({ where: { token } });
        }
        this.log?.warn({ status: response.status, body: text.slice(0, 200) }, 'push: FCM refused a message');
      } catch (error) {
        this.log?.warn({ err: (error as Error).message }, 'push: FCM send failed');
      }
    }

    return accepted;
  }
}

export const createPushSender = (
  prisma: PrismaClient,
  serviceAccountJson: string | undefined,
  log?: { warn: (obj: unknown, msg: string) => void },
): PushSender => {
  if (!serviceAccountJson) return new NoopPushSender();
  try {
    return new FcmPushSender(prisma, parseServiceAccount(serviceAccountJson), log);
  } catch (error) {
    log?.warn({ err: (error as Error).message }, 'push: FCM disabled, service account unusable');
    return new NoopPushSender();
  }
};
