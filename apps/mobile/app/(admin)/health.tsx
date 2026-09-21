/**
 * System health (§2.3.7, FR-ADM-01).
 *
 * `GET /admin/health` is not implemented on the backend yet, so this shows what
 * the app can prove for itself - the public health probe, the socket state and
 * the clock offset - rather than empty worker rows.
 */
import React from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { Card, Divider, Text } from 'react-native-paper';

import { API_BASE_URL } from '../../src/api/client';
import { useRealtimeStore } from '../../src/stores/realtime';
import { StatusDot } from '../../src/components/StatusDot';
import { spacing } from '../../src/theme';

export default function AdminHealth() {
  const socketStatus = useRealtimeStore((state) => state.status);
  const clockOffset = useRealtimeStore((state) => state.clockOffsetMs);
  const lastEventAt = useRealtimeStore((state) => state.lastEventAt);

  const health = useQuery({
    queryKey: ['health'],
    queryFn: async () => {
      const response = await fetch(`${API_BASE_URL}/health`);
      return (await response.json()) as { status: string; db: string; time: string };
    },
    refetchInterval: 15_000,
  });

  return (
    <ScrollView
      contentContainerStyle={styles.container}
      refreshControl={<RefreshControl refreshing={health.isFetching} onRefresh={() => void health.refetch()} />}
    >
      <Card mode="outlined">
        <Card.Title
          title="API"
          left={() => <StatusDot state={health.data?.status === 'ok' ? 'ONLINE' : 'OFFLINE'} />}
        />
        <Card.Content>
          <Row label="Endpoint" value={API_BASE_URL} />
          <Divider />
          <Row label="Status" value={health.data?.status ?? (health.isError ? 'unreachable' : '…')} />
          <Divider />
          <Row label="Database" value={health.data?.db ?? '—'} />
          <Divider />
          <Row label="Server time" value={health.data?.time ?? '—'} />
        </Card.Content>
      </Card>

      <Card mode="outlined">
        <Card.Title
          title="Realtime"
          left={() => <StatusDot state={socketStatus === 'connected' ? 'ONLINE' : 'OFFLINE'} />}
        />
        <Card.Content>
          <Row label="Socket" value={socketStatus} />
          <Divider />
          <Row label="Clock offset" value={`${Math.round(clockOffset / 1000)} s`} />
          <Divider />
          <Row
            label="Last event"
            value={lastEventAt ? new Date(lastEventAt).toLocaleTimeString('en-GB') : 'none yet'}
          />
        </Card.Content>
      </Card>

      <Text variant="bodySmall" style={styles.note}>
        Worker lag and pending-command counts arrive with GET /admin/health.
      </Text>
    </ScrollView>
  );
}

const Row: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <View style={styles.row}>
    <Text variant="bodyMedium">{label}</Text>
    <Text variant="bodySmall" style={styles.value} numberOfLines={1}>
      {value}
    </Text>
  </View>
);

const styles = StyleSheet.create({
  container: { padding: spacing(2), gap: spacing(1.5) },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6, gap: 12 },
  value: { flexShrink: 1, textAlign: 'right', opacity: 0.8 },
  note: { opacity: 0.7, textAlign: 'center' },
});
