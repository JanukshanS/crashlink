/**
 * §5.4.8 Admin routes.
 *
 * Implemented here: device provisioning, listing, revoke, the user list and
 * `GET /admin/health` (FR-ADM-01, NFR-11). The `/demo/*` routes are served by
 * the `demo:reset` / `demo:check` CLIs instead and are not stubbed here.
 */
import type { FastifyInstance } from 'fastify';
import { ListAdminUsersQuerySchema, ProvisionDeviceRequestSchema } from '@crashlink/contracts';
import { requireUser } from '../../plugins/auth.js';
import { notFound } from '../../lib/errors.js';
import { toIso } from '../../lib/time.js';
import { toUserDto } from '../auth/service.js';
import { ProvisioningService } from './provisioning.js';
import { deviceOnlineState } from '../bikes/service.js';
import { API_VERSION } from '../../version.js';
import type { AppDeps } from '../../app.js';

export const registerAdminRoutes = async (app: FastifyInstance, deps: AppDeps): Promise<void> => {
  const service = new ProvisioningService({
    prisma: app.prisma,
    deviceSecretKey: deps.config.DEVICE_SECRET_KEY,
  });

  const adminOnly = [app.authenticate, app.requireRole('ADMIN')];

  /** The only response that ever carries the raw device secret (§5.7.1). */
  app.post('/admin/devices', { preHandler: adminOnly }, async (request, reply) => {
    const body = ProvisionDeviceRequestSchema.parse(request.body ?? {});
    return reply.status(201).send(await service.provision(body.code));
  });

  app.get('/admin/devices', { preHandler: adminOnly }, async (_request, reply) => {
    const devices = await app.prisma.device.findMany({
      include: { bike: { select: { label: true } } },
      orderBy: { code: 'asc' },
    });

    return reply.send({
      items: devices.map((device) => ({
        id: device.id,
        code: device.code,
        paired: device.bike !== null,
        bikeLabel: device.bike?.label ?? null,
        lastSeenAt: toIso(device.lastSeenAt),
        fw: device.firmwareVersion,
        revoked: device.revokedAt !== null,
      })),
    });
  });

  app.post<{ Params: { id: string } }>(
    '/admin/devices/:id/revoke',
    { preHandler: adminOnly },
    async (request, reply) => {
      const auth = requireUser(request);

      const device = await app.prisma.device.findUnique({
        where: { id: request.params.id },
        select: { id: true },
      });
      if (!device) throw notFound('Device');

      await service.revoke(device.id, auth.id, deps.clock.now());
      return reply.status(204).send();
    },
  );

  /**
   * FR-ADM-01 / NFR-11: DB, worker last-run and lag, stale devices, pending
   * commands. `staleDevices` lists paired devices that are not ONLINE - an
   * unpaired device in a drawer is not a problem worth flagging.
   */
  app.get('/admin/health', { preHandler: adminOnly }, async (_request, reply) => {
    const now = deps.clock.now();

    let db: 'ok' | 'error' = 'ok';
    try {
      await app.prisma.$queryRaw`SELECT 1`;
    } catch {
      db = 'error';
    }

    const [paired, pendingCommands] = await Promise.all([
      app.prisma.bike.findMany({
        where: { deviceId: { not: null } },
        select: { ignition: true, device: { select: { code: true, lastSeenAt: true, config: true, revokedAt: true } } },
      }),
      app.prisma.deviceCommand.count({
        where: { status: { in: ['QUEUED', 'DELIVERED'] }, expiresAt: { gt: now } },
      }),
    ]);

    const staleDevices = paired
      .filter(
        (bike) =>
          bike.device &&
          !bike.device.revokedAt &&
          deviceOnlineState(bike.device.lastSeenAt, bike.ignition === 'ON', bike.device.config, now) !== 'ONLINE',
      )
      .map((bike) => bike.device!.code)
      .sort();

    return reply.send({
      db,
      workers: app.workers.snapshot(),
      staleDevices,
      pendingCommands,
      version: API_VERSION,
    });
  });

  app.get('/admin/users', { preHandler: adminOnly }, async (request, reply) => {
    const query = ListAdminUsersQuerySchema.parse(request.query ?? {});

    const users = await app.prisma.user.findMany({
      where: query.role ? { role: query.role } : {},
      orderBy: { createdAt: 'asc' },
    });

    return reply.send({ items: users.map(toUserDto) });
  });
};
