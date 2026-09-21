/** Bike detail (§2.3.3): location + freshness, device health, rental actions. */
import React, { useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Button, Card, Chip, Text, useTheme } from 'react-native-paper';
import { useTranslation } from 'react-i18next';
import * as Crypto from 'expo-crypto';

import { useBike, useEndRental } from '../../../../src/api/hooks/useBikes';
import { useIsReadOnly } from '../../../../src/stores/auth';
import { FreshnessBadge } from '../../../../src/components/FreshnessBadge';
import { DeviceHealthCard } from '../../../../src/components/IncidentTimeline';
import { LeafletMap } from '../../../../src/components/LeafletMap';
import { CallButtons } from '../../../../src/components/CallButtons';
import { RidingParkedCard } from '../../../../src/components/RidingParkedCard';
import { SAFE_GREEN, SECURITY_AMBER, spacing } from '../../../../src/theme';

export default function BikeDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const theme = useTheme();
  const { t } = useTranslation();

  const bike = useBike(id);
  const endRental = useEndRental();
  const readOnly = useIsReadOnly();
  const [error, setError] = useState<string | null>(null);

  const data = bike.data;

  const onEnd = async (): Promise<void> => {
    if (!data?.activeRental) return;
    setError(null);
    try {
      await endRental.mutateAsync({
        rentalId: data.activeRental.id,
        idempotencyKey: Crypto.randomUUID(),
      });
    } catch {
      setError('Could not end the rental.');
    }
  };

  if (!data) {
    return (
      <ScrollView contentContainerStyle={styles.container}>
        <Text>{bike.isLoading ? t('common.loading') : t('common.error')}</Text>
      </ScrollView>
    );
  }

  return (
    <ScrollView
      contentContainerStyle={styles.container}
      refreshControl={<RefreshControl refreshing={bike.isFetching} onRefresh={() => void bike.refetch()} />}
    >
      <Card mode="elevated">
        <Card.Title title={data.label} subtitle={`${data.plateNo ?? 'No plate'} · ${data.status}`} />
        <Card.Content style={styles.section}>
          <View style={styles.row}>
            <Chip compact icon={data.ignition.state === 'ON' ? 'key' : 'key-outline'}>
              {data.ignition.state}
            </Chip>
            {/* Every location carries its freshness (§2.3.3). */}
            <FreshnessBadge location={data.location} compact />
          </View>

          {data.location.lat !== null && data.location.lon !== null ? (
            <>
              <LeafletMap
                height={200}
                markers={[
                  {
                    id: data.id,
                    lat: data.location.lat,
                    lon: data.location.lon,
                    label: data.label,
                    color: SAFE_GREEN,
                  },
                ]}
              />
              <Text variant="bodySmall">
                {data.location.lat.toFixed(5)}, {data.location.lon.toFixed(5)}
                {data.location.speedKph !== null ? ` · ${data.location.speedKph.toFixed(1)} km/h` : ''}
              </Text>
            </>
          ) : (
            <Text variant="bodySmall">No location reported yet</Text>
          )}
        </Card.Content>
      </Card>

      {data.activeRental ? (
        <Card mode="outlined">
          <Card.Title title={t('owner.assignRental')} subtitle={data.activeRental.state} />
          <Card.Content style={styles.section}>
            <Text variant="titleSmall">{data.activeRental.driverName}</Text>
            <Text variant="bodySmall">
              {(data.activeRental.distanceM / 1000).toFixed(2)} km this ride
            </Text>
            {/* RENTAL_END_TIMEOUT_SEC: the server ends it without the bike after 10 min. */}
            {data.activeRental.state === 'ENDING_SYNC' ? (
              <Text variant="bodySmall" style={{ color: SECURITY_AMBER }}>
                {t('owner.endingSync')}
              </Text>
            ) : null}
            {readOnly || data.activeRental.state === 'ENDING_SYNC' ? null : (
              <Button mode="outlined" onPress={() => void onEnd()} loading={endRental.isPending}>
                {t('owner.endRental')}
              </Button>
            )}
          </Card.Content>
        </Card>
      ) : readOnly ? null : (
        <Button
          mode="contained"
          icon="account-plus"
          onPress={() => router.push(`/(owner)/bikes/${id}/assign` as never)}
          disabled={!data.device}
        >
          {t('owner.assignRental')}
        </Button>
      )}

      {!data.device ? (
        <Text variant="bodySmall" style={{ color: theme.colors.error }}>
          Pair a device before assigning a rider.
        </Text>
      ) : null}

      {/* FR-RENT-06: riding vs parked today, walked from ignition events. */}
      <RidingParkedCard
        ridingSec={data.ridingSecToday}
        parkedSec={data.parkedSecToday}
        unknownSec={data.unknownSecToday}
        parkedSinceSec={data.parkedSinceSec}
        ignition={data.ignition.state}
      />

      <DeviceHealthCard
        health={data.health}
        online={data.device?.online ?? 'OFFLINE'}
        lastSeenAt={data.device?.lastSeenAt ?? null}
        configVersion={data.device?.configVersion}
        configPending={data.device?.configPending}
      />

      {readOnly ? null : (
        <Button mode="text" onPress={() => router.push(`/(owner)/bikes/${id}/config` as never)}>
          Device settings
        </Button>
      )}

      {error ? (
        <Text variant="bodySmall" style={{ color: theme.colors.error }}>
          {error}
        </Text>
      ) : null}

      <CallButtons showEmergencyServices targets={[]} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: spacing(2), gap: spacing(1.5) },
  section: { gap: spacing(1) },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
});
