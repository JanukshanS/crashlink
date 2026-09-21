/**
 * realtimeStore (§4.2) - socket status and the server clock offset.
 *
 * The clock offset is the important part. Every countdown in this app is driven
 * by `responseDeadlineAt - (Date.now() + clockOffset)` (§2.4), never by the
 * handset's own clock: a phone whose time is 40 seconds fast would show a rider
 * that their 60-second window had already closed.
 */
import { create } from 'zustand';

export type SocketStatus = 'idle' | 'connecting' | 'connected' | 'disconnected';

export interface RealtimeState {
  status: SocketStatus;
  /** serverTime - localTimeAtResponse, in milliseconds. */
  clockOffsetMs: number;
  lastEventAt: number | null;

  setStatus: (status: SocketStatus) => void;
  /**
   * Records the offset from any response that carried a server timestamp.
   * The round trip is halved out: the server sent `serverTime` roughly halfway
   * through the request, so comparing it to the mid-point is closer than
   * comparing it to the moment the reply landed.
   */
  syncClock: (serverTimeIso: string, requestStartedAt: number) => void;
  markEvent: () => void;
}

export const useRealtimeStore = create<RealtimeState>((set) => ({
  status: 'idle',
  clockOffsetMs: 0,
  lastEventAt: null,

  setStatus: (status) => set({ status }),

  syncClock: (serverTimeIso, requestStartedAt) => {
    const serverMs = Date.parse(serverTimeIso);
    if (Number.isNaN(serverMs)) return;

    const receivedAt = Date.now();
    const midpoint = requestStartedAt + (receivedAt - requestStartedAt) / 2;
    set({ clockOffsetMs: serverMs - midpoint });
  },

  markEvent: () => set({ lastEventAt: Date.now() }),
}));

/** "Now" on the server's clock, which is the only one deadlines are measured in. */
export const serverNow = (): number => Date.now() + useRealtimeStore.getState().clockOffsetMs;

/** Milliseconds left until an ISO deadline, floored at zero. */
export const msUntil = (deadlineIso: string | null | undefined): number => {
  if (!deadlineIso) return 0;
  const deadline = Date.parse(deadlineIso);
  if (Number.isNaN(deadline)) return 0;
  return Math.max(0, deadline - serverNow());
};
