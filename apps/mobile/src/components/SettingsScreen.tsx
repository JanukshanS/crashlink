/**
 * Shared settings (§2.3.7) - used by the owner, driver and admin tabs.
 *
 * Two things are deliberately not offered:
 *  - Emergency alerts cannot be switched off (shown locked).
 *  - Password reset does not exist in this build (M11); the screen says so
 *    instead of offering a button that goes nowhere.
 */
import React, { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Button, Card, Divider, List, RadioButton, Switch, Text, useTheme } from 'react-native-paper';
import { useTranslation } from 'react-i18next';
import Constants from 'expo-constants';

import { useAuthStore, useIsReadOnly } from '../stores/auth';
import { useRealtimeStore } from '../stores/realtime';
import { useLogout } from '../api/hooks/useAuth';
import { API_BASE_URL } from '../api/client';
import { sendTestNotification } from '../notifications';
import { LANGUAGE_LABELS, SUPPORTED_LANGUAGES, setLanguage, type Language } from '../i18n';
import { spacing } from '../theme';

export const SettingsScreen: React.FC = () => {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const user = useAuthStore((state) => state.user);
  const readOnly = useIsReadOnly();
  const socketStatus = useRealtimeStore((state) => state.status);
  const clockOffset = useRealtimeStore((state) => state.clockOffsetMs);
  const logout = useLogout();

  const [notifySecurity, setNotifySecurity] = useState(true);
  const [notifyInfo, setNotifyInfo] = useState(false);
  const [alarmSound, setAlarmSound] = useState(true);

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Card mode="outlined">
        <Card.Title title={user?.name ?? '—'} subtitle={`${user?.role ?? ''} · ${user?.email ?? ''}`} />
        <Card.Content>
          <Text variant="bodySmall">{user?.phone ?? t('common.notMeasured')}</Text>
        </Card.Content>
      </Card>

      <Card mode="outlined">
        <Card.Title title="Language" />
        <Card.Content>
          <RadioButton.Group
            value={i18n.language}
            onValueChange={(value) => void setLanguage(value as Language)}
          >
            {SUPPORTED_LANGUAGES.map((language) => (
              <RadioButton.Item key={language} label={LANGUAGE_LABELS[language]} value={language} />
            ))}
          </RadioButton.Group>
          <Text variant="bodySmall" style={styles.hint}>
            Emergency screen strings are translated first.
          </Text>
        </Card.Content>
      </Card>

      <Card mode="outlined">
        <Card.Title title="Notifications" />
        <Card.Content>
          {/* §2.3.7: emergency alerts are always on, and shown as locked. */}
          <List.Item
            title="Emergency alerts"
            description="Always on"
            right={() => <Switch value disabled />}
          />
          <Divider />
          <List.Item
            title="Security alerts"
            right={() => <Switch value={notifySecurity} onValueChange={setNotifySecurity} />}
          />
          <Divider />
          <List.Item
            title="Ride events"
            right={() => <Switch value={notifyInfo} onValueChange={setNotifyInfo} />}
          />
          <Divider />
          <List.Item
            title="Alarm sound"
            right={() => <Switch value={alarmSound} onValueChange={setAlarmSound} />}
          />
          <Button mode="outlined" onPress={() => void sendTestNotification()} style={styles.button}>
            Send test notification
          </Button>
        </Card.Content>
      </Card>

      <Card mode="outlined">
        <Card.Title title="About" />
        <Card.Content style={styles.about}>
          <Row label="App version" value={Constants.expoConfig?.version ?? '1.0.0'} />
          <Row label="API" value={API_BASE_URL} />
          <Row label="Realtime" value={socketStatus} />
          <Row label="Clock offset" value={`${Math.round(clockOffset / 1000)}s`} />
          <Text variant="bodySmall" style={[styles.hint, { color: theme.colors.error }]}>
            {t('emergency.notEmergencyService')}
          </Text>
          <Text variant="bodySmall" style={styles.hint}>
            Location is recorded during rentals. On an incident the bike texts the owner and, if you
            do not answer, your emergency contact. A photo may be captured and is visible to the
            bike owner only.
          </Text>
          {/* M11: no password reset in this build. */}
          <Text variant="bodySmall" style={styles.hint}>
            {t('auth.noReset')}
          </Text>
        </Card.Content>
      </Card>

      <Button
        mode="contained-tonal"
        icon="logout"
        onPress={() => logout.mutate()}
        loading={logout.isPending}
        disabled={readOnly && false}
      >
        {t('auth.logout')}
      </Button>
    </ScrollView>
  );
};

const Row: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <View style={styles.row}>
    <Text variant="bodyMedium">{label}</Text>
    <Text variant="bodySmall" style={styles.rowValue} numberOfLines={1}>
      {value}
    </Text>
  </View>
);

const styles = StyleSheet.create({
  container: { padding: spacing(2), gap: spacing(2) },
  about: { gap: 6 },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  rowValue: { flexShrink: 1, textAlign: 'right', opacity: 0.8 },
  hint: { opacity: 0.75, marginTop: 6 },
  button: { marginTop: spacing(1) },
});
