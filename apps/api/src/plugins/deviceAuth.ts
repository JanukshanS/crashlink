/**
 * §5.3.2 device authentication, in the query-string form of Appendix E.1.2
 * (which overrides §5.3.2 where they differ).
 *
 *   ?dev=CL-0001&ts=<unix>&nonce=<hex>&sig=<hmac hex>
 *
 * Checks, in order (§5.3.2): device exists and is not revoked -> |now - ts| <=
 * 300 s -> nonce unused for this device within the window -> body hash matches
 * -> constant-time signature compare.
 *
 * NOT wrapped in `fastify-plugin`: it installs a raw-body content-type parser,
 * which must stay inside the `/d/v1` scope. Breaking that encapsulation would
 * hand every `/api/v1` route a Buffer instead of parsed JSON.
 */
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { Device } from '@prisma/client';
import {
  DEVICE_BODY_LIMIT_BYTES,
  DEVICE_RATE_LIMIT_PER_MIN,
  DEVICE_TIMESTAMP_WINDOW_SEC,
  DeviceAuthQuerySchema,
} from '@crashlink/contracts';
import { AppError } from '../lib/errors.js';
import { decryptSecret } from '../lib/crypto.js';
import { verifySignature } from '../lib/hmac.js';
import type { Clock } from '../lib/time.js';

declare module 'fastify' {
  interface FastifyRequest {
    device?: Device;
    rawBody?: Buffer;
  }
  interface FastifyInstance {
    authenticateDevice: preHandlerHookHandler;
  }
}

export interface DeviceAuthOptions {
  deviceSecretKey: string;
  clock: Clock;
}

/** The path the signature covers: no query string, ever (Appendix E.1.2). */
export const signedPath = (request: FastifyRequest): string => {
  const [path] = request.url.split('?');
  return path ?? request.url;
};

export const registerDeviceAuth = async (
  scope: FastifyInstance,
  options: DeviceAuthOptions,
): Promise<void> => {
  const { clock, deviceSecretKey } = options;

  /**
   * `/d/v1` bodies arrive as raw bytes: the JSON is parsed only after the
   * signature over those exact bytes has been verified, and image chunks are
   * octet-stream anyway.
   */
  scope.addContentTypeParser(
    ['application/json', 'application/octet-stream', 'text/plain'],
    // §5.7.4 oversized payloads: 413 PAYLOAD_TOO_LARGE even without Nginx.
    { parseAs: 'buffer', bodyLimit: DEVICE_BODY_LIMIT_BYTES },
    (request, body, done) => {
      const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
      request.rawBody = buffer;
      done(null, buffer);
    },
  );

  // A body with no content-type at all still needs a raw buffer.
  scope.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: DEVICE_BODY_LIMIT_BYTES }, (request, body, done) => {
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    request.rawBody = buffer;
    done(null, buffer);
  });

  scope.decorate('authenticateDevice', async (request: FastifyRequest) => {
    const parsed = DeviceAuthQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw new AppError('BAD_SIGNATURE', 'Missing or malformed device authentication parameters.');
    }

    const { dev, ts, nonce, sig } = parsed.data;

    const device = await scope.prisma.device.findUnique({ where: { code: dev } });
    // An unknown code answers exactly like a wrong key: the gateway must not
    // confirm which device codes exist.
    if (!device) throw new AppError('BAD_SIGNATURE', 'Device authentication failed.');
    if (device.revokedAt) throw new AppError('DEVICE_REVOKED', 'This device has been revoked.');

    const nowSec = Math.floor(clock.now().getTime() / 1000);
    if (Math.abs(nowSec - ts) > DEVICE_TIMESTAMP_WINDOW_SEC) {
      throw new AppError('STALE_TIMESTAMP', 'Device timestamp is outside the accepted window.', {
        serverEpoch: nowSec,
      });
    }

    const body = request.rawBody ?? Buffer.alloc(0);

    // Verify before recording the nonce, so a forged request cannot burn a
    // nonce that the real device is about to use.
    const secret = decryptSecret(device.secretEnc, deviceSecretKey);
    const ok = verifySignature(
      { method: request.method, path: signedPath(request), dev, ts, nonce, body },
      secret,
      sig,
    );
    if (!ok) throw new AppError('BAD_SIGNATURE', 'Device authentication failed.');

    // §5.3.2 replay protection. (deviceId, nonce) is the primary key, so the
    // duplicate insert *is* the detection - no read-then-write race.
    try {
      await scope.prisma.deviceNonce.create({
        data: { deviceId: device.id, nonce, createdAt: clock.now() },
      });
    } catch {
      throw new AppError('REPLAYED_NONCE', 'This request has already been seen.');
    }

    /**
     * §5.4.10 / §5.7.4 flooding: 60 requests per minute *per device*.
     *
     * Counted from the nonces just recorded, which only exist for requests
     * whose signature verified. That makes it genuinely per device - an
     * attacker who puts a real bike's code in `dev=` cannot spend that bike's
     * quota - and it survives a restart. An IP key would be wrong here: SIM
     * cards sit behind carrier NAT and many bikes can share one address.
     */
    const windowStart = new Date(clock.now().getTime() - 60_000);
    const recent = await scope.prisma.deviceNonce.count({
      where: { deviceId: device.id, createdAt: { gt: windowStart } },
    });
    if (recent > DEVICE_RATE_LIMIT_PER_MIN) {
      throw new AppError('RATE_LIMITED', 'This device is sending too many requests.', {
        limitPerMinute: DEVICE_RATE_LIMIT_PER_MIN,
      });
    }

    request.device = device;
  });
};

/** The authenticated device, or a 401 - for use inside a `/d/v1` handler. */
export const requireDevice = (request: FastifyRequest): Device => {
  if (!request.device) throw new AppError('BAD_SIGNATURE', 'Device authentication failed.');
  return request.device;
};
