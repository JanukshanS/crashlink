/**
 * AuthGate (§2.2, §4.2) - splash / session restore, then role-based routing.
 *
 * §2.1: OWNER and GUEST share the owner experience (guest read-only), DRIVER
 * gets the driver tabs, ADMIN gets the admin tabs.
 */
import React, { useEffect } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useRouter, useSegments } from 'expo-router';
import { Text } from 'react-native-paper';
import { routeGroupForRole, useAuthStore } from '../stores/auth';

export const AuthGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const router = useRouter();
  const segments = useSegments();
  const user = useAuthStore((state) => state.user);
  const hydrated = useAuthStore((state) => state.hydrated);
  const restore = useAuthStore((state) => state.restore);

  useEffect(() => {
    void restore();
  }, [restore]);

  useEffect(() => {
    if (!hydrated) return;

    const current = segments[0];
    // The emergency screen outranks routing: if it is up, the rider is mid
    // safety check and must not be redirected out of it.
    if (current === 'emergency') return;

    const inAuthGroup = current === '(auth)';

    if (!user) {
      if (!inAuthGroup) router.replace('/(auth)/welcome');
      return;
    }

    const group = routeGroupForRole(user.role);
    if (inAuthGroup || !current) {
      router.replace(`/${group}` as never);
      return;
    }

    // A role that somehow lands in another role's group is sent home rather
    // than shown screens its token cannot load.
    const groups = ['(owner)', '(driver)', '(admin)'];
    if (groups.includes(current) && current !== group) {
      router.replace(`/${group}` as never);
    }
  }, [hydrated, user, segments, router]);

  if (!hydrated) {
    return (
      <View style={styles.splash}>
        <Text variant="headlineMedium" style={styles.brand}>
          CrashLink
        </Text>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  return <>{children}</>;
};

const styles = StyleSheet.create({
  splash: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 24 },
  brand: { fontWeight: '700', letterSpacing: 0.5 },
});
