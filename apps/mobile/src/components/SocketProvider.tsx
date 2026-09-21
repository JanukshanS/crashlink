/**
 * SocketProvider (§4.2, §5.5).
 *
 * Connects once there is an access token and reconnects when it rotates.
 * Disconnects on background so a phone in a pocket is not holding a socket
 * open on a metered 2G link, and reconnects on foreground - which also
 * triggers the full query invalidation in `connectSocket`.
 */
import React, { useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '../stores/auth';
import { connectSocket, disconnectSocket } from '../realtime/socket';

export const SocketProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const queryClient = useQueryClient();
  const accessToken = useAuthStore((state) => state.accessToken);
  const role = useAuthStore((state) => state.user?.role);
  const appState = useRef<AppStateStatus>(AppState.currentState);

  useEffect(() => {
    if (!accessToken || !role) {
      disconnectSocket();
      return;
    }

    connectSocket({ accessToken, queryClient, role });
    return () => disconnectSocket();
  }, [accessToken, role, queryClient]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      const previous = appState.current;
      appState.current = next;

      if (!accessToken || !role) return;

      if (previous.match(/inactive|background/) && next === 'active') {
        connectSocket({ accessToken, queryClient, role });
      } else if (next.match(/inactive|background/)) {
        disconnectSocket();
      }
    });

    return () => subscription.remove();
  }, [accessToken, role, queryClient]);

  return <>{children}</>;
};
