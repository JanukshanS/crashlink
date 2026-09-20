/**
 * FR-DEV-01 / §5.4.8 device provisioning.
 *
 * Shared by `POST /admin/devices` and the `device:provision` CLI, so a device
 * created at the terminal is identical to one created through the API.
 *
 * Secret handling (§5.7.1):
 *  - the HMAC secret is stored **encrypted** (AES-256-GCM), because verifying a
 *    device signature needs the raw bytes back - hashing it would make the
 *    whole device protocol unusable;
 *  - the pairing code is stored **hashed** (bcrypt): the server only ever needs
 *    to check one a person typed in;
 *  - both are returned exactly once, at provisioning.
 */
import bcrypt from 'bcryptjs';
import type { Prisma, PrismaClient } from '@prisma/client';
import {
  DEFAULT_DEVICE_CONFIG,
  type ProvisionDeviceResponse,
  DeviceCodeSchema,
} from '@crashlink/contracts';
import {
  encryptSecret,
  generateApPassword,
  generateDeviceSecret,
  generatePairingCode,
} from '../../lib/crypto.js';
import { conflict } from '../../lib/errors.js';

export interface ProvisioningDeps {
  prisma: PrismaClient;
  /** 32-byte hex key from DEVICE_SECRET_KEY. */
  deviceSecretKey: string;
}

/** Allocates the next free CL-NNNN when the caller does not name one. */
const nextDeviceCode = async (prisma: PrismaClient): Promise<string> => {
  const latest = await prisma.device.findMany({
    where: { code: { startsWith: 'CL-' } },
    select: { code: true },
    orderBy: { code: 'desc' },
    take: 1,
  });

  const highest = latest[0]?.code;
  const nextNumber = highest ? Number.parseInt(highest.slice(3), 10) + 1 : 1;
  return `CL-${String(nextNumber).padStart(4, '0')}`;
};

export class ProvisioningService {
  constructor(private readonly deps: ProvisioningDeps) {}

  async provision(requestedCode?: string): Promise<ProvisionDeviceResponse> {
    const { prisma, deviceSecretKey } = this.deps;

    const code = requestedCode
      ? DeviceCodeSchema.parse(requestedCode)
      : await nextDeviceCode(prisma);

    const existing = await prisma.device.findUnique({ where: { code }, select: { id: true } });
    if (existing) throw conflict('CONFLICT', `Device ${code} already exists.`);

    const secret = generateDeviceSecret();
    const pairingCode = generatePairingCode();
    const cameraSecret = generateDeviceSecret();
    const apPassword = generateApPassword();

    const device = await prisma.device.create({
      data: {
        code,
        secretEnc: encryptSecret(secret, deviceSecretKey),
        pairingCodeHash: await bcrypt.hash(pairingCode, 10),
        configVersion: DEFAULT_DEVICE_CONFIG.configVersion,
        appliedConfigVersion: 0,
        config: {
          ...DEFAULT_DEVICE_CONFIG,
          // §5.3.11: the camera link and AP credentials live with the config the
          // device pulls, not in a separate table.
          cameraSecret,
          apPassword,
        } as unknown as Prisma.InputJsonValue,
      },
    });

    await prisma.auditEvent.create({
      data: {
        actorType: 'ADMIN',
        action: 'DEVICE_PROVISIONED',
        targetType: 'DEVICE',
        targetId: device.id,
        meta: { code },
      },
    });

    return { id: device.id, code: device.code, secret, pairingCode, cameraSecret, apPassword };
  }

  /** FR-DEV-06: a revoked device gets 401 DEVICE_REVOKED on every call. */
  async revoke(deviceId: string, actorId: string, now: Date): Promise<void> {
    const { prisma } = this.deps;

    await prisma.device.update({ where: { id: deviceId }, data: { revokedAt: now } });

    await prisma.auditEvent.create({
      data: {
        actorType: 'USER',
        actorId,
        action: 'DEVICE_REVOKED',
        targetType: 'DEVICE',
        targetId: deviceId,
        meta: {},
      },
    });
  }
}
