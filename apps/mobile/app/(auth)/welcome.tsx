/** Welcome (§2.2): log in, register, or continue as judge. */
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Button, Text, useTheme } from 'react-native-paper';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useGuestLogin } from '../../src/api/hooks/useAuth';
import { spacing } from '../../src/theme';

export default function Welcome() {
  const router = useRouter();
  const theme = useTheme();
  const { t } = useTranslation();
  const guest = useGuestLogin();
  const insets = useSafeAreaInsets();

  return (
    <View
      style={[
        styles.container,
        { backgroundColor: theme.colors.background, paddingTop: insets.top + spacing(3), paddingBottom: insets.bottom + spacing(2) },
      ]}
    >
      <View style={styles.hero}>
        <Text variant="displaySmall" style={styles.brand}>
          {t('auth.welcomeTitle')}
        </Text>
        <Text variant="titleMedium" style={styles.tagline}>
          {t('auth.welcomeTagline')}
        </Text>
      </View>

      <View style={styles.actions}>
        <Button mode="contained" onPress={() => router.push('/(auth)/login')} contentStyle={styles.tall} labelStyle={styles.label}>
          {t('auth.login')}
        </Button>

        <Button mode="outlined" onPress={() => router.push('/(auth)/register')} contentStyle={styles.tall} labelStyle={styles.label}>
          {t('auth.register')}
        </Button>

        {/* FR-AUTH-05: read-only demo owner for judges. */}
        <Button
          mode="text"
          onPress={() => guest.mutate()}
          loading={guest.isPending}
          disabled={guest.isPending}
        >
          {t('auth.guest')}
        </Button>

        {guest.isError ? (
          <Text variant="bodySmall" style={{ color: theme.colors.error, textAlign: 'center' }}>
            Guest access is not enabled on this server.
          </Text>
        ) : null}
      </View>

      <Text variant="bodySmall" style={styles.disclaimer}>
        {t('emergency.notEmergencyService')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: spacing(3), justifyContent: 'space-between' },
  hero: { flex: 1, justifyContent: 'center', gap: spacing(1) },
  brand: { fontWeight: '800', letterSpacing: 0.5 },
  tagline: { opacity: 0.75 },
  actions: { gap: spacing(1.5) },
  tall: { height: 52 },
  // Some Android OEM fonts (vivo, Oppo) measure bold labels short and clip them to "Log …".
  label: { fontSize: 16, lineHeight: 24, paddingHorizontal: 4 },
  disclaimer: { textAlign: 'center', opacity: 0.6, marginTop: spacing(3) },
});
