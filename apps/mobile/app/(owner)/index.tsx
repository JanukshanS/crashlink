/**
 * Owner dashboard (§2.3.6), from `GET /owners/me/dashboard` in one round trip:
 *
 *   1. emergency banner (only while an EMERGENCY incident is open)
 *   2. KPI cards 2x2
 *   3. fleet map
 *   4. bike status list
 *   5. recent activity (last 10)
 */
import React from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Banner, Card, Chip, Text, useTheme } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { useDashboard } from '../../src/api/hooks/useAnalytics';
import { KpiCard } from '../../src/components/KpiCard';
import { StatusDot } from '../../src/components/StatusDot';
import { FreshnessBadge } from '../../src/components/FreshnessBadge';
import { LeafletMap, type MapMarker } from '../../src/components/LeafletMap';
import { EmptyChart } from '../../src/components/charts/ChartCard';
import { formatDateTime } from '../../src/lib/format';
import { CATEGORY_COLORS, EMERGENCY_RED, HEALTH_COLORS, SAFE_GREEN, spacing } from '../../src/theme';

export default function OwnerDashboard() {
  const theme = useTheme();
  const router = useRouter();
  const { t } = useTranslation();

  const dashboard = useDashboard();
  const data = dashboard.data;

  const bikes = data?.bikes ?? [];
  const recent = data?.recent ?? [];
  const kpis = data?.kpis;

  const markers: MapMarker[] = bikes
    .filter((bike) => bike.location.lat !== null && bike.location.lon !== null)
    .map((bike) => ({
      id: bike.id,
      lat: bike.location.lat!,
      lon: bike.location.lon!,
      label: bike.label,
      color:
        bike.device?.online === 'ONLINE'
          ? SAFE_GREEN
          : bike.device?.online === 'STALE'
            ? HEALTH_COLORS.degraded
            : HEALTH_COLORS.down,
      // Freshness travels with the marker, so the popup cannot imply "now".
      sublabel:
        bike.location.source === 'DEMO'
          ? 'DEMO location'
          : bike.location.kind === 'LIVE' && (bike.location.ageSec ?? 0) <= 30
            ? 'Live fix'
            : `Last known · ${Math.max(1, Math.round((bike.location.ageSec ?? 0) / 60))} min`,
    }));

  return (
    <ScrollView
      contentContainerStyle={styles.container}
      refreshControl={<RefreshControl refreshing={dashboard.isFetching} onRefresh={() => void dashboard.refetch()} />}
    >
      {/* §2.3.6: shown until the owner acknowledges it. */}
      {data?.openEmergency ? (
        <Banner
          visible
          icon="alert-octagon"
          style={{ backgroundColor: EMERGENCY_RED }}
          actions={[
            {
              label: 'Open',
              labelStyle: { color: '#FFFFFF' },
              onPress: () => router.push(`/(owner)/incidents/${data.openEmergency!.id}` as never),
            },
          ]}
        >
          <Text style={styles.bannerText}>
            {data.openEmergency.label} · {data.openEmergency.bikeLabel} ·{' '}
            {formatDateTime(data.openEmergency.occurredAt)}
          </Text>
        </Banner>
      ) : null}

      {dashboard.isError && !data ? (
        <Card mode="outlined">
          <Card.Content>
            <EmptyChart
              icon="cloud-off-outline"
              title="Could not load the dashboard"
              explanation="Pull down to try again. The last dashboard you saw is shown while offline."
            />
          </Card.Content>
        </Card>
      ) : null}

      <View style={styles.kpiGrid}>
        <KpiCard
          label={t('owner.bikesOnline')}
          value={kpis ? `${kpis.bikesOnline}/${kpis.bikesTotal}` : '—'}
          color={kpis && kpis.bikesTotal > 0 && kpis.bikesOnline === kpis.bikesTotal ? SAFE_GREEN : undefined}
          onPress={() => router.push('/(owner)/bikes' as never)}
        />
        <KpiCard label={t('owner.activeRentals')} value={kpis?.activeRentals ?? '—'} />
        <KpiCard
          label={t('owner.openIncidents')}
          value={kpis?.openIncidents ?? '—'}
          color={kpis && kpis.openIncidents > 0 ? EMERGENCY_RED : undefined}
          onPress={() => router.push('/(owner)/incidents' as never)}
        />
        <KpiCard label={t('owner.incidentsToday')} value={kpis?.incidentsToday ?? '—'} />
      </View>

      <Card mode="outlined">
        <Card.Title title={t('owner.fleetMap')} titleVariant="titleMedium" />
        <Card.Content>
          {markers.length > 0 ? (
            <LeafletMap
              markers={markers}
              height={220}
              onMarkerPress={(id) => router.push(`/(owner)/bikes/${id}` as never)}
            />
          ) : (
            <EmptyChart
              icon="map-marker-off-outline"
              title={bikes.length === 0 ? 'No bikes yet' : 'No positions reported yet'}
              explanation={
                bikes.length === 0
                  ? 'Add a bike and pair its device - each bike appears here as a coloured marker.'
                  : 'Each bike appears here once its device reports a GPS fix, coloured by whether it is online.'
              }
            />
          )}
        </Card.Content>
      </Card>

      <Text variant="titleMedium">{t('owner.bikes')}</Text>
      {bikes.length === 0 && !dashboard.isLoading ? (
        <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
          No bikes yet. Add one from the Bikes tab.
        </Text>
      ) : null}
      {bikes.map((bike) => (
        <Card key={bike.id} mode="outlined" onPress={() => router.push(`/(owner)/bikes/${bike.id}` as never)}>
          <Card.Content style={styles.row}>
            <View style={styles.main}>
              <View style={styles.rowGap}>
                <StatusDot state={bike.device?.online ?? 'OFFLINE'} />
                <Text variant="titleSmall">{bike.label}</Text>
              </View>
              <Text variant="bodySmall">
                {bike.activeRental ? bike.activeRental.driverName : 'No active rental'} · ignition{' '}
                {bike.ignition.state}
              </Text>
            </View>
            <FreshnessBadge location={bike.location} compact />
          </Card.Content>
        </Card>
      ))}

      <Text variant="titleMedium">{t('owner.recentActivity')}</Text>
      {recent.length === 0 && !dashboard.isLoading ? (
        <Card mode="outlined">
          <Card.Content>
            <EmptyChart
              icon="bell-outline"
              title="No activity yet"
              explanation="The last ten events across your fleet - possible falls, towing, potholes - appear here as bikes report them."
            />
          </Card.Content>
        </Card>
      ) : null}
      {recent.map((incident) => (
        <Card
          key={incident.id}
          mode="outlined"
          onPress={() => router.push(`/(owner)/incidents/${incident.id}` as never)}
        >
          <Card.Content style={styles.row}>
            <View style={styles.main}>
              {/* Appendix D: the "Possible …" label exactly as the API sends it. */}
              <Text variant="titleSmall">{incident.label}</Text>
              <Text variant="bodySmall">
                {incident.bikeLabel} · {formatDateTime(incident.occurredAt)}
              </Text>
            </View>
            <Chip compact style={{ backgroundColor: CATEGORY_COLORS[incident.category] }} textStyle={styles.chipText}>
              {incident.category}
            </Chip>
          </Card.Content>
        </Card>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: spacing(2), gap: spacing(1.5), paddingBottom: spacing(4) },
  kpiGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing(1) },
  bannerText: { color: '#FFFFFF', fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  main: { flex: 1, gap: 4 },
  rowGap: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  chipText: { color: '#FFFFFF', fontSize: 11 },
});
