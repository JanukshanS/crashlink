/**
 * §5.5 realtime - Socket.IO on the same HTTP server, path `/socket.io`.
 *
 * Connections authenticate with the same access token as the REST API, and are
 * joined to `user:<id>`, plus `owner:<id>` for owners and `admin` for admins.
 * The socket is only a hint: the app re-fetches over REST on connect, and every
 * event here is also reachable by polling (§5.5, FR-NOT-05).
 */
import fp from 'fastify-plugin';
import { Server, type Socket } from 'socket.io';
import type { FastifyInstance } from 'fastify';
import type { Role, SocketEventName, SocketEventPayloads } from '@crashlink/contracts';
import { ADMIN_ROOM, SOCKET_PATH, ownerRoom, userRoom } from '@crashlink/contracts';
import type { RealtimeEmitter } from '../lib/realtime.js';

declare module 'fastify' {
  interface FastifyInstance {
    io: Server;
    realtime: RealtimeEmitter;
  }
}

export interface SocketPluginOptions {
  corsOrigin?: boolean | string | string[];
}

export default fp<SocketPluginOptions>(
  async (app: FastifyInstance, options: SocketPluginOptions) => {
    const io = new Server(app.server, {
      path: SOCKET_PATH,
      cors: { origin: options.corsOrigin ?? true, credentials: true },
      // The app runs over 2G-ish links too; let it fall back if websocket fails.
      transports: ['websocket', 'polling'],
    });

    io.use((socket: Socket, next) => {
      const token =
        (socket.handshake.auth as { token?: string } | undefined)?.token ??
        socket.handshake.headers.authorization?.replace(/^Bearer /i, '');

      if (!token) return next(new Error('UNAUTHORIZED'));

      try {
        const payload = app.jwt.verify<{ sub: string; role: Role; isDemo: boolean }>(token);
        socket.data.userId = payload.sub;
        socket.data.role = payload.role;
        return next();
      } catch {
        return next(new Error('UNAUTHORIZED'));
      }
    });

    io.on('connection', (socket: Socket) => {
      const userId = socket.data.userId as string;
      const role = socket.data.role as Role;

      void socket.join(userRoom(userId));
      if (role === 'OWNER') void socket.join(ownerRoom(userId));
      if (role === 'ADMIN') void socket.join(ADMIN_ROOM);

      app.log.debug({ userId, role }, 'socket connected');
    });

    const emitter: RealtimeEmitter = {
      toOwner<E extends SocketEventName>(ownerId: string, event: E, payload: SocketEventPayloads[E]) {
        io.to(ownerRoom(ownerId)).emit(event, payload);
      },
      toUser<E extends SocketEventName>(userId: string, event: E, payload: SocketEventPayloads[E]) {
        io.to(userRoom(userId)).emit(event, payload);
      },
    };

    app.decorate('io', io);
    app.decorate('realtime', emitter);

    app.addHook('onClose', async () => {
      await io.close();
    });
  },
  { name: 'socket', dependencies: ['auth'] },
);
