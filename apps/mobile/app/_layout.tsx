/**
 * Root layout (§4.2): Paper, QueryClient, AuthGate, SocketProvider,
 * NotificationBridge, EmergencyWatcher.
 *
 * The order matters. AuthGate decides which route group is mounted, the socket
 * only connects once there is a token, and EmergencyWatcher sits above every
 * screen so the safety question can interrupt whatever the rider is looking at.
 */
import React, { useEffect, useState } from 'react';
import { AppState, LogBox, Platform, useColorScheme, type AppStateStatus } from 'react-native';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import type { MD3Theme } from 'react-native-paper';
import { PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { focusManager, QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import '../src/i18n';
import { darkTheme, lightTheme } from '../src/theme';
import { AuthGate } from '../src/components/AuthGate';
import { SocketProvider } from '../src/components/SocketProvider';
import { NotificationBridge } from '../src/components/NotificationBridge';
import { EmergencyWatcher } from '../src/components/EmergencyWatcher';
import { registerNotificationChannels } from '../src/notifications';

/**
 * React Navigation draws headers, tab bars and screen backgrounds itself. Left
 * on its default light theme it paints a light page and dark-on-dark header
 * titles under Paper's dark theme, so it is derived from the Paper theme.
 */
const navigationTheme = (paper: MD3Theme, dark: boolean) => {
  const base = dark ? DarkTheme : DefaultTheme;
  return {
    ...base,
    colors: {
      ...base.colors,
      primary: paper.colors.primary,
      background: paper.colors.background,
      card: paper.colors.surface,
      text: paper.colors.onSurface,
      border: paper.colors.outlineVariant,
      notification: paper.colors.error,
    },
  };
};

// Raised inside expo-router's JS stack (bikes/incidents), not by app code; dev-only.
LogBox.ignoreLogs(['InteractionManager has been deprecated']);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A rider on GPRS should see the last known state rather than a spinner.
      staleTime: 10_000,
      gcTime: 24 * 60 * 60 * 1000,
      retry: 2,
      refetchOnWindowFocus: true,
    },
    mutations: { retry: 0 },
  },
});

/**
 * FR-NOT-05: polling runs only in the foreground. TanStack pauses
 * refetchInterval while unfocused, and in React Native "focused" means the app
 * is active - which it does not know unless told.
 */
const onAppStateChange = (status: AppStateStatus): void => {
  if (Platform.OS !== 'web') focusManager.setFocused(status === 'active');
};

/** §4.2: the cache is persisted so the last dashboard shows offline. */
const persister = createAsyncStoragePersister({
  storage: AsyncStorage,
  key: 'crashlink.query-cache',
});

export default function RootLayout() {
  const scheme = useColorScheme();
  const [channelsReady, setChannelsReady] = useState(false);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', onAppStateChange);
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    // §2.3.4: channels must exist before the first notification is posted.
    void registerNotificationChannels().finally(() => setChannelsReady(true));
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <PersistQueryClientProvider
          client={queryClient}
          persistOptions={{
            persister,
            maxAge: 24 * 60 * 60 * 1000,
            // Never persist the emergency question: it must be re-read from the
            // server, never restored from a stale cache.
            dehydrateOptions: {
              shouldDehydrateQuery: (query) =>
                !query.queryKey.includes('pending-question') && query.state.status === 'success',
            },
          }}
        >
          <PaperProvider theme={scheme === 'dark' ? darkTheme : lightTheme}>
            <ThemeProvider
              value={navigationTheme(scheme === 'dark' ? darkTheme : lightTheme, scheme === 'dark')}
            >
            <StatusBar style="auto" />
            <AuthGate>
              <SocketProvider>
                <NotificationBridge enabled={channelsReady} />
                <EmergencyWatcher />
                <Stack screenOptions={{ headerShown: false }}>
                  <Stack.Screen name="(auth)" />
                  <Stack.Screen name="(owner)" />
                  <Stack.Screen name="(driver)" />
                  <Stack.Screen name="(admin)" />
                  <Stack.Screen
                    name="emergency/[incidentId]"
                    options={{
                      presentation: 'fullScreenModal',
                      // §2.4: no gesture dismissal - the question must be answered.
                      gestureEnabled: false,
                      animation: 'fade',
                    }}
                  />
                </Stack>
              </SocketProvider>
            </AuthGate>
            </ThemeProvider>
          </PaperProvider>
        </PersistQueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
