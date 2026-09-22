/**
 * Device settings (§2.3.2, §2.3.7, FR-DEV-05).
 *
 * The two safety parameters - 5 s fall check and 60 s response window - are
 * **display only**. They were agreed by the team (S5) and the server rejects
 * changes from an owner, so the UI does not pretend they are editable.
 *
 * `PUT /bikes/:id/device-config` has not landed on the backend yet, so the
 * editable fields are shown read-only with a note rather than offering a Save
 * button that would 404.
 */
import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Card, Chip, Divider, Text, useTheme } from 'react-native-paper';

import { useBike } from '../../../../src/api/hooks/useBikes';
import { SECURITY_AMBER, spacing } from '../../../../src/theme';

const Row: React.FC<{ label: string; value: string; locked?: boolean }> = ({
  label,
  value,
  locked,
}) => (
  <View style={styles.row}>
    <View style={styles.rowMain}>
      <Text variant="bodyMedium">{label}</Text>
      {locked ? (
        <Chip compact icon="lock" style={styles.lockChip} textStyle={styles.lockText}>
          safety parameter
        </Chip>
      ) : null}
    </View>
    <Text variant="bodyMedium">{value}</Text>
  </View>
);

export default function DeviceConfig() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const theme = useTheme();
  const bike = useBike(id);

  const config = bike.data?.config;
  const device = bike.data?.device;

  if (!config) {
    return (
      <ScrollView contentContainerStyle={styles.container}>
        <Text>{bike.isLoading ? 'Loading…' : 'No device paired to this bike.'}</Text>
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Card mode="outlined">
        <Card.Title
          title="Sync state"
          subtitle={device?.configPending ? 'Pending sync with the bike' : 'Applied by the bike'}
        />
        <Card.Content>
          <Row label="Config version" value={`v${config.configVersion}`} />
          <Divider />
          <Row label="Firmware" value={bike.data?.health?.fw ?? '—'} />
        </Card.Content>
      </Card>

      {/* §2.3.7: locked safety parameters, shown but not editable. */}
      <Card mode="outlined" style={{ borderColor: SECURITY_AMBER }}>
        <Card.Title title="Safety parameters" subtitle="Agreed by the team · read-only" />
        <Card.Content>
          <Row label="Fall confirmation" value={`${config.fallConfirmSec} s`} locked />
          <Divider />
          <Row label="Response window" value={`${config.responseWindowSec} s`} locked />
          <Divider />
          <Row label="Offline fallback" value={`${config.offlineFallbackSec} s`} locked />
          <Divider />
          <Row label="Deadline grace" value={`${config.deadlineGraceSec} s`} locked />
        </Card.Content>
      </Card>

      <Card mode="outlined">
        <Card.Title title="Telemetry" />
        <Card.Content>
          <Row label="Interval (ignition ON)" value={`${config.telemetryOnSec} s`} />
          <Divider />
          <Row label="Interval (ignition OFF)" value={`${config.telemetryOffSec} s`} />
          <Divider />
          <Row label="Control poll" value={`${config.controlPollSec} s`} />
        </Card.Content>
      </Card>

      <Card mode="outlined">
        <Card.Title title="Detection thresholds" />
        <Card.Content>
          <Row label="Fall angle" value={`${config.fallAngleDeg}°`} />
          <Divider />
          <Row label="Impact" value={`${config.impactG} g`} />
          <Divider />
          <Row label="Rotation" value={`${config.rotationDps} °/s`} />
          <Divider />
          <Row label="Cornering lean" value={`${config.cornerLeanDeg}°`} />
          <Divider />
          <Row label="Pothole" value={`${config.potholeG} g`} />
          <Divider />
          <Row label="Towing" value={`${config.towMinSpeedKph} km/h for ${config.towMinSec} s`} />
          <Divider />
          <Row label="Demo mode" value={config.demoMode ? 'on' : 'off'} />
        </Card.Content>
      </Card>

      <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
        Editing device configuration is not available in this build. Values are read from the device
        and shown as the bike has them.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: spacing(2), gap: spacing(1.5) },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 6, gap: 8 },
  rowMain: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, flexWrap: 'wrap' },
  lockChip: { backgroundColor: SECURITY_AMBER },
  lockText: { color: '#FFFFFF', fontSize: 10 },
});
