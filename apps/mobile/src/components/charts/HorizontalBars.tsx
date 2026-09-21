/**
 * HorizontalBars - categorical data on a narrow screen.
 *
 * Vertical bars force a label like "Possible towing / unauthorised movement"
 * into a few pixels under each bar, where it is either truncated or rotated.
 * Horizontal rows give every label the full width, which is what makes a
 * category chart readable on a 6-inch phone.
 */
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Text, useTheme } from 'react-native-paper';

export interface BarItem {
  key: string;
  label: string;
  value: number;
  /** Text shown at the end of the bar; defaults to the value. */
  valueLabel?: string;
  color: string;
  /** Extra line under the label, e.g. "no rides". */
  note?: string;
}

export interface HorizontalBarsProps {
  items: BarItem[];
  /** Fixed maximum, when rows must be comparable across charts. */
  max?: number;
}

/** A non-zero value never renders narrower than this, so it stays visible. */
const MIN_VISIBLE_PERCENT = 2;

export const HorizontalBars: React.FC<HorizontalBarsProps> = ({ items, max }) => {
  const theme = useTheme();
  const scaleMax = max ?? Math.max(0, ...items.map((item) => item.value));

  return (
    <View style={styles.list}>
      {items.map((item) => {
        const percent =
          scaleMax <= 0 || item.value <= 0
            ? 0
            : Math.max(MIN_VISIBLE_PERCENT, (item.value / scaleMax) * 100);
        const valueText = item.valueLabel ?? String(item.value);

        return (
          <View
            key={item.key}
            style={styles.row}
            accessible
            accessibilityLabel={`${item.label}: ${valueText}${item.note ? `, ${item.note}` : ''}`}
          >
            <View style={styles.labelRow}>
              <Text variant="bodyMedium" style={styles.label} numberOfLines={2}>
                {item.label}
              </Text>
              <Text variant="labelLarge" style={styles.value}>
                {valueText}
              </Text>
            </View>
            <View style={[styles.track, { backgroundColor: theme.colors.surfaceVariant }]}>
              <View style={[styles.fill, { width: `${percent}%`, backgroundColor: item.color }]} />
            </View>
            {item.note ? (
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                {item.note}
              </Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
};

const styles = StyleSheet.create({
  list: { gap: 12 },
  row: { gap: 4 },
  labelRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 },
  label: { flex: 1 },
  value: { fontVariant: ['tabular-nums'] },
  track: { height: 12, borderRadius: 6, overflow: 'hidden' },
  fill: { height: 12, borderRadius: 6 },
});
