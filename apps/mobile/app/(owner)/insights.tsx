/**
 * Insights (§2.3.5), backed by the §5.4.7 analytics endpoints.
 *
 *   incidents over time  -> /analytics/incidents-timeseries  (stacked daily bars)
 *   incidents by type    -> /analytics/incidents-by-type     (horizontal bars)
 *   response outcomes    -> /analytics/response-outcomes     (owner only)
 *   distance per bike    -> /analytics/distance-by-bike
 *   pothole map          -> /analytics/potholes              (Leaflet markers)
 *
 * Riding vs parked time is per bike, on bike detail: §5.4.7 has no fleet-wide
 * endpoint for it and this screen adds none.
 */
import React, { useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { SegmentedButtons, Text, useTheme } from 'react-native-paper';

import {
  useAnalyticsRange,
  useDistanceByBike,
  useIncidentsByType,
  useIncidentsTimeseries,
  usePotholes,
  useResponseOutcomes,
} from '../../src/api/hooks/useAnalytics';
import { useIsReadOnly } from '../../src/stores/auth';
import { ChartCard } from '../../src/components/charts/ChartCard';
import { HorizontalBars } from '../../src/components/charts/HorizontalBars';
import { DailyStackedBars } from '../../src/components/charts/DailyStackedBars';
import { LeafletMap } from '../../src/components/LeafletMap';
import { formatDateTime, formatDayKey, formatKm } from '../../src/lib/format';
import {
  CATEGORY_COLORS,
  EMERGENCY_RED,
  INFO_BLUE,
  SAFE_GREEN,
  SECURITY_AMBER,
  spacing,
} from '../../src/theme';

const RANGES = [7, 14, 30] as const;

/** Colour each type by its category, so the legend in "over time" still applies. */
const TYPE_CATEGORY: Record<string, keyof typeof CATEGORY_COLORS> = {
  POSSIBLE_COLLISION: 'EMERGENCY',
  POSSIBLE_LOW_SPEED_RIDER_DROP: 'EMERGENCY',
  POSSIBLE_ROLLOVER: 'EMERGENCY',
  MANUAL_SOS: 'EMERGENCY',
  PARKED_BIKE_FALL: 'SECURITY',
  POSSIBLE_TOWING: 'SECURITY',
  POSSIBLE_TAMPERING: 'SECURITY',
  DEVICE_OFFLINE_DURING_RENTAL: 'SECURITY',
  POSSIBLE_POTHOLE: 'INFO',
  POSSIBLE_DANGEROUS_CORNERING: 'INFO',
};

export default function Insights() {
  const theme = useTheme();
  const readOnly = useIsReadOnly();

  const [days, setDays] = useState<number>(14);
  const [refreshKey, setRefreshKey] = useState(0);
  const range = useAnalyticsRange(days, refreshKey);

  const timeseries = useIncidentsTimeseries(range);
  const byType = useIncidentsByType(range);
  // §5.4.7: owner only. A guest is told why, not shown an error.
  const outcomes = useResponseOutcomes(range, !readOnly);
  const distance = useDistanceByBike(range);
  const potholes = usePotholes(range);

  const refreshing =
    timeseries.isFetching || byType.isFetching || outcomes.isFetching || distance.isFetching || potholes.isFetching;

  const period = `last ${days} days`;

  // --- over time -------------------------------------------------------------
  const seriesItems = timeseries.data?.items ?? [];
  const seriesTotal = seriesItems.reduce((sum, item) => sum + item.EMERGENCY + item.SECURITY + item.INFO, 0);
  const busiest = seriesItems.reduce<{ date: string; total: number } | null>((best, item) => {
    const total = item.EMERGENCY + item.SECURITY + item.INFO;
    return total > (best?.total ?? 0) ? { date: item.date, total } : best;
  }, null);

  // --- by type ---------------------------------------------------------------
  const typeItems = (byType.data?.items ?? []).map((item) => ({
    key: item.type,
    // Appendix D label, verbatim from the API.
    label: item.label,
    value: item.count,
    color: CATEGORY_COLORS[TYPE_CATEGORY[item.type] ?? 'INFO'],
  }));

  // --- outcomes --------------------------------------------------------------
  const o = outcomes.data;
  const outcomeTotal = o ? o.SAFE + o.HELP + o.TIMEOUT + o.OFFLINE_FALLBACK : 0;
  const outcomeItems = o
    ? [
        { key: 'SAFE', label: 'Rider said they were safe', value: o.SAFE, color: SAFE_GREEN },
        { key: 'HELP', label: 'Rider asked for help', value: o.HELP, color: EMERGENCY_RED },
        { key: 'TIMEOUT', label: 'No answer in time - contact escalated', value: o.TIMEOUT, color: SECURITY_AMBER },
        {
          key: 'OFFLINE_FALLBACK',
          label: 'Bike was offline and escalated on its own',
          value: o.OFFLINE_FALLBACK,
          color: INFO_BLUE,
        },
      ]
    : [];

  // --- distance --------------------------------------------------------------
  const distanceItems = (distance.data?.items ?? []).map((item) => ({
    key: item.bikeId,
    label: item.label,
    value: item.distanceM,
    valueLabel: formatKm(item.distanceM),
    color: theme.colors.primary,
    note: item.distanceM === 0 ? 'no rides started in this period' : undefined,
  }));
  const anyDistance = distanceItems.some((item) => item.value > 0);

  // --- potholes --------------------------------------------------------------
  const potholeItems = potholes.data?.items ?? [];

  return (
    <ScrollView
      contentContainerStyle={styles.container}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => setRefreshKey((key) => key + 1)} />}
    >
      <SegmentedButtons
        value={String(days)}
        onValueChange={(value) => setDays(Number(value))}
        buttons={RANGES.map((value) => ({ value: String(value), label: `${value} days` }))}
      />

      <ChartCard
        title="Incidents over time"
        subtitle={period}
        summary={
          seriesTotal > 0
            ? `${seriesTotal} in ${days} days${busiest ? ` · busiest ${formatDayKey(busiest.date)} (${busiest.total})` : ''}`
            : undefined
        }
        loading={timeseries.isLoading}
        error={timeseries.isError}
        empty={
          seriesTotal === 0
            ? {
                icon: 'calendar-blank-outline',
                title: `No incidents in the ${period}`,
                explanation:
                  'Each day gets a bar split into emergency, security and ride events as your bikes report them.',
              }
            : null
        }
      >
        <DailyStackedBars items={seriesItems} />
      </ChartCard>

      <ChartCard
        title="Incidents by type"
        subtitle={period}
        loading={byType.isLoading}
        error={byType.isError}
        empty={
          typeItems.length === 0
            ? {
                icon: 'format-list-bulleted-type',
                title: 'Nothing detected yet',
                explanation:
                  'Every event a bike reports - possible falls, towing, potholes, sharp cornering - is counted here by type.',
              }
            : null
        }
      >
        <HorizontalBars items={typeItems} />
      </ChartCard>

      {readOnly ? (
        <ChartCard
          title="Safety check outcomes"
          empty={{
            icon: 'lock-outline',
            title: 'Owner only',
            explanation:
              'How riders answered their safety checks is visible to the bike owner, not in the demo view.',
          }}
        />
      ) : (
        <ChartCard
          title="Safety check outcomes"
          subtitle={period}
          summary={
            o && outcomeTotal > 0
              ? o.medianResponseSec !== null
                ? `Median time to answer: ${Math.round(o.medianResponseSec)} s`
                : 'No rider answered in time during this period'
              : undefined
          }
          loading={outcomes.isLoading}
          error={outcomes.isError && !outcomes.forbidden}
          empty={
            outcomeTotal === 0
              ? {
                  icon: 'shield-check-outline',
                  title: `No safety checks in the ${period}`,
                  explanation:
                    'When a possible fall asks a rider "Are you safe?", how it ended - safe, help, no answer or offline - is counted here.',
                }
              : null
          }
        >
          <HorizontalBars items={outcomeItems} />
        </ChartCard>
      )}

      <ChartCard
        title="Distance per bike"
        subtitle={`Rides started in the ${period}`}
        loading={distance.isLoading}
        error={distance.isError}
        empty={
          distanceItems.length === 0
            ? {
                icon: 'motorbike',
                title: 'No bikes yet',
                explanation: 'Add a bike and its trip distance from each rental will be totalled here.',
              }
            : !anyDistance
              ? {
                  icon: 'map-marker-distance',
                  title: `No rides in the ${period}`,
                  explanation:
                    'Each bike’s total trip distance appears here once a rental starts and the bike reports GPS.',
                }
              : null
        }
      >
        <HorizontalBars items={distanceItems} />
      </ChartCard>

      <ChartCard
        title="Pothole map"
        subtitle={period}
        summary={
          potholeItems.length > 0
            ? `${potholeItems.length} possible pothole${potholeItems.length === 1 ? '' : 's'} · tap a marker for details`
            : undefined
        }
        loading={potholes.isLoading}
        error={potholes.isError}
        empty={
          potholeItems.length === 0
            ? {
                icon: 'road-variant',
                title: `No potholes detected in the ${period}`,
                explanation:
                  'Sharp vertical jolts at speed are pinned on a map here, so you can see which roads are rough on your bikes.',
              }
            : null
        }
      >
        <LeafletMap
          height={260}
          markers={potholeItems.map((item, index) => ({
            id: `${item.at}-${index}`,
            lat: item.lat,
            lon: item.lon,
            label: 'Possible pothole / speed bump',
            color: CATEGORY_COLORS.INFO,
            sublabel: `${item.peakG !== null ? `${item.peakG.toFixed(1)} g · ` : ''}${formatDateTime(item.at)}`,
          }))}
        />
      </ChartCard>

      <View style={styles.note}>
        <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
          Days are counted in Sri Lanka time. Riding vs parked time is on each bike’s page.
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: spacing(2), gap: spacing(1.5), paddingBottom: spacing(4) },
  note: { paddingHorizontal: spacing(1) },
});
