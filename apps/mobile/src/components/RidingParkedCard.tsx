/**
 * Riding vs parked time today (§2.3.5, FR-RENT-06), for bike detail.
 *
 * One bar split into riding, parked and unknown. "Unknown" is drawn, not
 * hidden: before the bike first reports an ignition state we do not know what
 * it was doing, and folding that time into "parked" would be inventing data.
 */
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Card, Chip, Text, useTheme } from 'react-native-paper';
import { formatDuration } from '../lib/format';
import { SAFE_GREEN, spacing } from '../theme';
import { EmptyChart } from './charts/ChartCard';

const PARKED_GREY = '#8A8F98';

export interface RidingParkedCardProps {
  ridingSec: number;
  parkedSec: number;
  unknownSec: number;
  parkedSinceSec: number | null;
  ignition: string;
}

export const RidingParkedCard: React.FC<RidingParkedCardProps> = ({
  ridingSec,
  parkedSec,
  unknownSec,
  parkedSinceSec,
  ignition,
}) => {
  const theme = useTheme();
  const total = ridingSec + parkedSec + unknownSec;
  const known = ridingSec + parkedSec;

  const segments = [
    { key: 'riding', sec: ridingSec, color: SAFE_GREEN, label: 'Riding' },
    { key: 'parked', sec: parkedSec, color: PARKED_GREY, label: 'Parked' },
    { key: 'unknown', sec: unknownSec, color: theme.colors.surfaceVariant, label: 'Not reporting' },
  ].filter((segment) => segment.sec > 0);

  return (
    <Card mode="outlined">
      <Card.Title title="Riding and parked today" titleVariant="titleMedium" />
      <Card.Content style={styles.content}>
        {known === 0 ? (
          <EmptyChart
            icon="key-outline"
            title="No ignition changes recorded today"
            explanation="Riding and parked time appear here once the bike reports its ignition turning on or off. Time before the first report is shown as not reporting, never guessed."
          />
        ) : (
          <>
            <View style={styles.totals}>
              <View style={styles.total}>
                <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                  Riding
                </Text>
                <Text variant="headlineSmall" style={[styles.number, { color: SAFE_GREEN }]}>
                  {formatDuration(ridingSec)}
                </Text>
              </View>
              <View style={styles.total}>
                <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                  Parked
                </Text>
                <Text variant="headlineSmall" style={styles.number}>
                  {formatDuration(parkedSec)}
                </Text>
              </View>
            </View>

            <View
              style={[styles.bar, { backgroundColor: theme.colors.surfaceVariant }]}
              accessible
              accessibilityLabel={`Riding ${formatDuration(ridingSec)}, parked ${formatDuration(parkedSec)}${
                unknownSec > 0 ? `, not reporting ${formatDuration(unknownSec)}` : ''
              }`}
            >
              {segments.map((segment) => (
                <View
                  key={segment.key}
                  style={{ flex: segment.sec / total, backgroundColor: segment.color }}
                />
              ))}
            </View>

            <View style={styles.legend}>
              {segments.map((segment) => (
                <View key={segment.key} style={styles.legendItem}>
                  <View style={[styles.swatch, { backgroundColor: segment.color }]} />
                  <Text variant="bodySmall">
                    {segment.label} {formatDuration(segment.sec)}
                  </Text>
                </View>
              ))}
            </View>
          </>
        )}

        {/* FR-RENT-06: "parked for X min" when the ignition is off. */}
        {ignition === 'OFF' && parkedSinceSec !== null ? (
          <Chip compact icon="parking" style={styles.chip}>
            Parked for {formatDuration(parkedSinceSec)}
          </Chip>
        ) : null}
      </Card.Content>
    </Card>
  );
};

const styles = StyleSheet.create({
  content: { gap: spacing(1.5) },
  totals: { flexDirection: 'row', gap: spacing(3) },
  total: { gap: 2 },
  number: { fontWeight: '700', fontVariant: ['tabular-nums'] },
  bar: { height: 16, borderRadius: 8, overflow: 'hidden', flexDirection: 'row' },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  swatch: { width: 12, height: 12, borderRadius: 3 },
  chip: { alignSelf: 'flex-start' },
});
