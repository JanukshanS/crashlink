/**
 * §5.5 realtime emitter.
 *
 * Services depend on this narrow interface rather than on Socket.IO, so the
 * same business logic runs under `app.inject()` in tests and, later, under an
 * MQTT subscriber - neither of which has a socket server. The socket is a hint
 * anyway: REST is the truth (§5.5).
 */
import type { SocketEventPayloads, SocketEventName } from '@crashlink/contracts';

export interface RealtimeEmitter {
  toOwner<E extends SocketEventName>(ownerId: string, event: E, payload: SocketEventPayloads[E]): void;
  toUser<E extends SocketEventName>(userId: string, event: E, payload: SocketEventPayloads[E]): void;
}

/** Used in tests and whenever the socket plugin is not registered. */
export const noopEmitter: RealtimeEmitter = {
  toOwner: () => undefined,
  toUser: () => undefined,
};

/** Records what would have been emitted - lets tests assert on §5.5 events. */
export class RecordingEmitter implements RealtimeEmitter {
  readonly events: { room: string; event: string; payload: unknown }[] = [];

  toOwner(ownerId: string, event: string, payload: unknown): void {
    this.events.push({ room: `owner:${ownerId}`, event, payload });
  }

  toUser(userId: string, event: string, payload: unknown): void {
    this.events.push({ room: `user:${userId}`, event, payload });
  }

  byName(event: string): { room: string; event: string; payload: unknown }[] {
    return this.events.filter((entry) => entry.event === event);
  }

  clear(): void {
    this.events.length = 0;
  }
}
