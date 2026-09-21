/**
 * Admin devices (§2.3.2, §5.4.8, FR-DEV-01).
 *
 * The secret is shown exactly once, on the response to provisioning. It is held
 * in component state only - never written to storage, never re-fetchable - and
 * the screen says so, because losing it means re-flashing the board.
 */
import React, { useState } from 'react';
import { RefreshControl, ScrollView, Share, StyleSheet, View } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, Chip, Dialog, Divider, Portal, Text, TextInput, useTheme } from 'react-native-paper';
import { useTranslation } from 'react-i18next';
import type { AdminDeviceDto, ProvisionDeviceResponse } from '@crashlink/contracts';

import { api, ApiError } from '../../src/api/client';
import { queryKeys } from '../../src/api/queryKeys';
import { SAFE_GREEN, spacing } from '../../src/theme';

export default function AdminDevices() {
  const theme = useTheme();
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const devices = useQuery({
    queryKey: queryKeys.adminDevices(),
    queryFn: async () => {
      const response = await api.get<{ items: AdminDeviceDto[] }>('/admin/devices');
      return response.items;
    },
  });

  const [code, setCode] = useState('');
  const [provisioned, setProvisioned] = useState<ProvisionDeviceResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const provision = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      const result = await api.post<ProvisionDeviceResponse>('/admin/devices', {
        ...(code.trim() ? { code: code.trim().toUpperCase() } : {}),
      });
      setProvisioned(result);
      setCode('');
      void queryClient.invalidateQueries({ queryKey: queryKeys.adminDevices() });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string): Promise<void> => {
    await api.post(`/admin/devices/${id}/revoke`).catch(() => undefined);
    void queryClient.invalidateQueries({ queryKey: queryKeys.adminDevices() });
  };

  return (
    <ScrollView
      contentContainerStyle={styles.container}
      refreshControl={<RefreshControl refreshing={devices.isFetching} onRefresh={() => void devices.refetch()} />}
    >
      <Card mode="outlined">
        <Card.Title title={t('admin.provision')} />
        <Card.Content style={styles.section}>
          <TextInput
            label="Device code (optional)"
            value={code}
            onChangeText={setCode}
            mode="outlined"
            placeholder="CL-0003 · blank for next free"
            autoCapitalize="characters"
          />
          <Button mode="contained" onPress={() => void provision()} loading={busy} disabled={busy}>
            {t('admin.provision')}
          </Button>
          {error ? (
            <Text variant="bodySmall" style={{ color: theme.colors.error }}>
              {error}
            </Text>
          ) : null}
        </Card.Content>
      </Card>

      {(devices.data ?? []).map((device) => (
        <Card key={device.id} mode="outlined">
          <Card.Content style={styles.deviceRow}>
            <View style={styles.main}>
              <Text variant="titleSmall">{device.code}</Text>
              <Text variant="bodySmall">
                {device.paired ? `Paired · ${device.bikeLabel ?? ''}` : 'Not paired'}
                {device.fw ? ` · fw ${device.fw}` : ''}
              </Text>
              <Text variant="bodySmall">
                {device.lastSeenAt
                  ? `Last seen ${new Date(device.lastSeenAt).toLocaleString('en-GB', { timeZone: 'Asia/Colombo' })}`
                  : 'Never reported'}
              </Text>
            </View>
            {device.revoked ? (
              <Chip compact icon="cancel">
                revoked
              </Chip>
            ) : (
              <Button mode="text" onPress={() => void revoke(device.id)}>
                Revoke
              </Button>
            )}
          </Card.Content>
        </Card>
      ))}

      {/* The one and only time this secret exists outside the firmware. */}
      <Portal>
        <Dialog visible={Boolean(provisioned)} onDismiss={() => setProvisioned(null)}>
          <Dialog.Title>{provisioned?.code}</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodySmall" style={{ color: theme.colors.error, marginBottom: 8 }}>
              {t('admin.secretOnce')}
            </Text>
            <SecretRow label="Secret" value={provisioned?.secret ?? ''} />
            <Divider />
            <SecretRow label="Pairing code" value={provisioned?.pairingCode ?? ''} />
            <Divider />
            <SecretRow label="Camera secret" value={provisioned?.cameraSecret ?? ''} />
            <Divider />
            <SecretRow label="AP password" value={provisioned?.apPassword ?? ''} />
          </Dialog.Content>
          <Dialog.Actions>
            <Button
              onPress={() => {
                if (!provisioned) return;
                void Share.share({
                  message:
                    `CL_DEVICE_CODE "${provisioned.code}"\n` +
                    `CL_DEVICE_SECRET "${provisioned.secret}"\n` +
                    `CL_CAMERA_SECRET "${provisioned.cameraSecret}"\n` +
                    `CL_AP_PASSWORD "${provisioned.apPassword}"`,
                });
              }}
            >
              Share to firmware
            </Button>
            <Button onPress={() => setProvisioned(null)}>{t('common.close')}</Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </ScrollView>
  );
}

const SecretRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <View style={styles.secretRow}>
    <Text variant="labelSmall">{label}</Text>
    <Text variant="bodySmall" selectable style={styles.mono}>
      {value}
    </Text>
  </View>
);

const styles = StyleSheet.create({
  container: { padding: spacing(2), gap: spacing(1.5) },
  section: { gap: spacing(1) },
  deviceRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  main: { flex: 1, gap: 2 },
  secretRow: { paddingVertical: 6, gap: 2 },
  mono: { fontFamily: 'monospace', color: SAFE_GREEN },
});
