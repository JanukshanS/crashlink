/**
 * Socket.IO client (§5.5).
 *
 * The socket is a **hint**, not the source of truth. Every event invalidates
 * the matching TanStack Query rather than writing the payload straight into the
 * cache, so the screen re-reads REST and cannot drift from the server (§5.5).
 *
 * The one exception is `incident.question`: that opens the emergency screen
 * immediately, because waiting for a refetch costs seconds out of a 60-second
 * window. The screen still verifies against REST once it is up.
 */
import { io, type Socket } from 'socket.io-client';
import type { QueryClient } from '@tanstack/react-query';
import {
  SOCKET_PATH,
  type IncidentSummaryDto,
  type RentalUpdatedEvent,
} from '@crashlink/contracts';
import { API_BASE_URL } from '../api/client';
import { useRealtimeStore } from '../stores/realtime';
import { useEmergencyStore } from '../stores/emergency';
import { queryKeys } from '../api/queryKeys';
import { showLocalIncidentNotification } from '../notifications';

let socket: Socket | null = null;

export interface ConnectOptions {
  accessToken: string;
  queryClient: QueryClient;
  /** The signed-in user's role, so we only wire the rooms they will get. */
  role: string;
}

export const connectSocket = ({ accessToken, queryClient, role }: ConnectOptions): Socket => {
  disconnectSocket();

  const store = useRealtimeStore.getState();
  store.setStatus('connecting');

  socket = io(API_BASE_URL, {
    path: SOCKET_PATH,
    auth: { token: accessToken },
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10_000,
    timeout: 10_000,
  });

  socket.on('connect', () => {
    useRealtimeStore.getState().setStatus('connected');
    // §5.5: "On connect, the app re-fetches active queries" - anything that
    // happened while the socket was down is now invisible to us otherwise.
    void queryClient.invalidateQueries();
  });

  socket.on('disconnect', () => useRealtimeStore.getState().setStatus('disconnected'));
  socket.on('connect_error', () => useRealtimeStore.getState().setStatus('disconnected'));

  const touch = (): void => useRealtimeStore.getState().markEvent();

  // --- fleet ---------------------------------------------------------------
  socket.on('bike.updated', () => {
    touch();
    void queryClient.invalidateQueries({ queryKey: queryKeys.bikes() });
    void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard() });
  });

  socket.on('device.status', () => {
    touch();
    void queryClient.invalidateQueries({ queryKey: queryKeys.bikes() });
  });

  socket.on('rental.updated', (payload: RentalUpdatedEvent) => {
    touch();
    void queryClient.invalidateQueries({ queryKey: queryKeys.rentals() });
    void queryClient.invalidateQueries({ queryKey: queryKeys.activeRental() });
    void queryClient.invalidateQueries({ queryKey: queryKeys.bikes() });
    void queryClient.invalidateQueries({ queryKey: queryKeys.rental(payload.id) });
  });

  // --- incidents -----------------------------------------------------------
  socket.on('incident.created', (payload: IncidentSummaryDto) => {
    touch();
    void queryClient.invalidateQueries({ queryKey: queryKeys.incidents() });
    void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard() });
    // Every chart counts incidents, so a new one makes them all stale.
    void queryClient.invalidateQueries({ queryKey: queryKeys.analytics() });

    // §2.3.4: the owner gets an attention aid; the truth still comes from REST.
    if (role === 'OWNER' && payload.category === 'EMERGENCY') {
      void showLocalIncidentNotification({
        incidentId: payload.id,
        title: payload.label,
        body: `${payload.bikeLabel} · tap to open`,
        category: payload.category,
      });
    }
  });

  socket.on('incident.updated', (payload: IncidentSummaryDto) => {
    touch();
    void queryClient.invalidateQueries({ queryKey: queryKeys.incidents() });
    void queryClient.invalidateQueries({ queryKey: queryKeys.incident(payload.id) });
  });

  /**
   * §2.4 trigger 1 of 3. This is the fastest path to the emergency screen; the
   * 5 s poll and the notification tap are the other two, and all three land in
   * the same store so the screen opens exactly once.
   */
  socket.on(
    'incident.question',
    (payload: {
      incidentId: string;
      label: string;
      occurredAt: string;
      questionSentAt: string;
      responseDeadlineAt: string;
      serverTime: string;
    }) => {
      touch();
      // Trust the server's clock, not the handset's (§2.4).
      useRealtimeStore.getState().syncClock(payload.serverTime, Date.now());

      useEmergencyStore.getState().open({
        incidentId: payload.incidentId,
        label: payload.label,
        occurredAt: payload.occurredAt,
        questionSentAt: payload.questionSentAt,
        responseDeadlineAt: payload.responseDeadlineAt,
      });

      void queryClient.invalidateQueries({ queryKey: queryKeys.pendingQuestion() });
    },
  );

  socket.on('incident.decision', (payload: { incidentId: string; decision: string; decidedAt: string }) => {
    touch();
    void queryClient.invalidateQueries({ queryKey: queryKeys.incident(payload.incidentId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.pendingQuestion() });

    // Someone or something else decided this incident - stop asking the rider.
    const emergency = useEmergencyStore.getState();
    if (emergency.question?.incidentId === payload.incidentId && (emergency.status === 'idle' || emergency.status === 'offline')) {
      emergency.setLosingDecision(payload.decision, payload.decidedAt);
    }
  });

  socket.on('notification.updated', (payload: { incidentId: string }) => {
    touch();
    void queryClient.invalidateQueries({ queryKey: queryKeys.incident(payload.incidentId) });
  });

  return socket;
};

export const disconnectSocket = (): void => {
  if (!socket) return;
  socket.removeAllListeners();
  socket.disconnect();
  socket = null;
  useRealtimeStore.getState().setStatus('idle');
};

export const getSocket = (): Socket | null => socket;
