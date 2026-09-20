/**
 * §5.4.2 profile routes: /me, settings, password, push tokens.
 *
 * Every route here is scoped to the caller's own row - there is no way to read
 * or write another user through this module.
 */
import type { FastifyInstance } from 'fastify';
import {
  ChangePasswordRequestSchema,
  PushTokenRequestSchema,
  UpdateMeRequestSchema,
  UserSettingsSchema,
} from '@crashlink/contracts';
import { requireUser } from '../../plugins/auth.js';
import { AuthService, toUserDto } from '../auth/service.js';
import { conflict, notFound } from '../../lib/errors.js';
import type { AppDeps } from '../../app.js';

export const registerUserRoutes = async (app: FastifyInstance, deps: AppDeps): Promise<void> => {
  const authService = new AuthService({
    prisma: app.prisma,
    app,
    clock: deps.clock,
    refreshTtlDays: deps.config.REFRESH_TOKEN_TTL_DAYS,
    accessTtlSec: deps.config.ACCESS_TOKEN_TTL_SEC,
    guestEnabled: deps.config.GUEST_ENABLED,
  });

  app.get('/me', { preHandler: app.authenticate }, async (request, reply) => {
    const auth = requireUser(request);

    const user = await app.prisma.user.findUnique({
      where: { id: auth.id },
      include: { settings: true },
    });
    if (!user) throw notFound('User');

    const hasEmergencyContact =
      user.role === 'DRIVER'
        ? (await app.prisma.emergencyContact.count({
            where: { driverId: user.id, isCurrent: true },
          })) > 0
        : false;

    return reply.send({
      ...toUserDto(user),
      settings: {
        notifySecurity: user.settings?.notifySecurity ?? true,
        notifyInfo: user.settings?.notifyInfo ?? false,
        alarmSound: user.settings?.alarmSound ?? true,
        theme: user.settings?.theme ?? 'system',
      },
      hasEmergencyContact,
    });
  });

  app.patch('/me', { preHandler: app.authenticate }, async (request, reply) => {
    const auth = requireUser(request);
    const body = UpdateMeRequestSchema.parse(request.body);

    if (body.phone) {
      const taken = await app.prisma.user.findFirst({
        where: { phoneE164: body.phone, id: { not: auth.id } },
        select: { id: true },
      });
      if (taken) throw conflict('PHONE_TAKEN', 'That phone number is already registered.');
    }

    const user = await app.prisma.user.update({
      where: { id: auth.id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.phone !== undefined ? { phoneE164: body.phone } : {}),
        ...(body.language !== undefined ? { language: body.language } : {}),
      },
    });

    return reply.send(toUserDto(user));
  });

  app.put('/me/settings', { preHandler: app.authenticate }, async (request, reply) => {
    const auth = requireUser(request);
    const body = UserSettingsSchema.parse(request.body);

    const settings = await app.prisma.userSettings.upsert({
      where: { userId: auth.id },
      create: { userId: auth.id, ...body },
      update: body,
    });

    return reply.send({
      notifySecurity: settings.notifySecurity,
      notifyInfo: settings.notifyInfo,
      alarmSound: settings.alarmSound,
      theme: settings.theme,
    });
  });

  app.post('/me/password', { preHandler: app.authenticate }, async (request, reply) => {
    const auth = requireUser(request);
    const body = ChangePasswordRequestSchema.parse(request.body);
    await authService.changePassword(auth.id, body.currentPassword, body.newPassword);
    return reply.status(204).send();
  });

  app.post('/me/push-tokens', { preHandler: app.authenticate }, async (request, reply) => {
    const auth = requireUser(request);
    const body = PushTokenRequestSchema.parse(request.body);

    // A handset that changes hands must not keep pushing to the previous owner,
    // so the token is re-pointed rather than duplicated.
    await app.prisma.pushToken.upsert({
      where: { token: body.token },
      create: { userId: auth.id, token: body.token, platform: body.platform },
      update: { userId: auth.id, platform: body.platform, lastSeenAt: deps.clock.now() },
    });

    return reply.status(204).send();
  });

  app.delete<{ Params: { token: string } }>(
    '/me/push-tokens/:token',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const auth = requireUser(request);
      await app.prisma.pushToken.deleteMany({
        where: { token: request.params.token, userId: auth.id },
      });
      return reply.status(204).send();
    },
  );
};
