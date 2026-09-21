/**
 * DailyStackedBars - §2.3.5 "incidents over time", one stacked bar per day.
 *
 * Sized from the measured width rather than a guess, so 7, 14 or 30 days all
 * fit a 6-inch phone without horizontal scrolling. Day labels are thinned to
 * at most ~6, because 30 labels in 300 px overlap into noise.
 *
 * Stacked bars rather than a line: incident counts are small whole numbers,
 * and a line between 0 and 1 invents a slope between events that never
 * happened.
 */
import React, { useMemo, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { BarChart } from 'react-native-gifted-charts';
import { Text, useTheme } from 'react-native-paper';
import type { IncidentsTimeseriesItem } from '@crashlink/contracts';
import { CATEGORY_COLORS } from '../../theme';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "21 Sep" - en-GB's "21 Sept" is one character too wide for a 6-inch axis. */
const shortDay = (key: string): string => {
  const [, month, day] = key.split('-').map(Number) as [number, number, number];
  return `${day} ${MONTHS[month - 1]}`;
};

const Y_AXIS_WIDTH = 28;
const EDGE = 6;
const MAX_LABELS = 6;
const CATEGORIES = ['EMERGENCY', 'SECURITY', 'INFO'] as const;

const LEGEND_LABELS: Record<(typeof CATEGORIES)[number], string> = {
  EMERGENCY: 'Emergency',
  SECURITY: 'Security',
  INFO: 'Ride events',
};

/** Whole-number axis: small counts must not show "0.5 incidents". */
const niceAxis = (max: number): { maxValue: number; sections: number } => {
  if (max <= 4) return { maxValue: Math.max(1, max), sections: Math.max(1, max) };
  const sections = 4;
  const step = Math.ceil(max / sections);
  return { maxValue: step * sections, sections };
};

export const DailyStackedBars: React.FC<{ items: IncidentsTimeseriesItem[]; height?: number }> = ({
  items,
  height = 160,
}) => {
  const theme = useTheme();
  const [width, setWidth] = useState(0);

  const onLayout = (event: LayoutChangeEvent): void => {
    const next = Math.floor(event.nativeEvent.layout.width);
    if (next !== width) setWidth(next);
  };

  const { data, barWidth, spacing, labelWidth, axis, totals } = useMemo(() => {
    const n = Math.max(1, items.length);
    const plot = Math.max(0, width - Y_AXIS_WIDTH - EDGE * 2);
    const slot = plot / n;
    const bar = Math.max(3, Math.floor(slot * 0.62));
    const gap = Math.max(1, slot - bar);
    const labelEvery = Math.max(1, Math.ceil(n / MAX_LABELS));
    // Room for "21 Sep" without ellipsis, never wider than the gap to the next label.
    const labelWidth = Math.max(36, Math.min(56, Math.floor(slot * labelEvery)));

    const categoryTotals = { EMERGENCY: 0, SECURITY: 0, INFO: 0 };
    let dayMax = 0;

    const stacked = items.map((item, index) => {
      const dayTotal = item.EMERGENCY + item.SECURITY + item.INFO;
      dayMax = Math.max(dayMax, dayTotal);
      for (const category of CATEGORIES) categoryTotals[category] += item[category];

      // Label the last day too, so "today" is always anchored - and drop a
      // regular label that would sit on top of it.
      const last = items.length - 1;
      const labelled = index === last || (index % labelEvery === 0 && last - index >= labelEvery);
      return {
        label: labelled ? shortDay(item.date) : '',
        // Per item: gifted-charts ignores the chart-level labelWidth for stacked bars.
        labelWidth,
        stacks: CATEGORIES.filter((category) => item[category] > 0).map(
          (category): { value: number; color: string } => ({
            value: item[category],
            color: CATEGORY_COLORS[category],
          }),
        ),
      };
    });

    // A day with nothing still needs a (zero) stack to hold its slot.
    for (const day of stacked) {
      if (day.stacks.length === 0) day.stacks.push({ value: 0, color: 'transparent' });
    }

    return {
      data: stacked,
      barWidth: bar,
      spacing: gap,
      labelWidth,
      axis: niceAxis(dayMax),
      totals: categoryTotals,
    };
  }, [items, width]);

  return (
    <View onLayout={onLayout} style={styles.container}>
      {width > 0 ? (
        <BarChart
          stackData={data}
          width={width - Y_AXIS_WIDTH}
          height={height}
          barWidth={barWidth}
          spacing={spacing}
          initialSpacing={EDGE}
          endSpacing={EDGE}
          maxValue={axis.maxValue}
          noOfSections={axis.sections}
          yAxisLabelWidth={Y_AXIS_WIDTH}
          yAxisThickness={0}
          xAxisThickness={1}
          xAxisColor={theme.colors.outlineVariant}
          rulesColor={theme.colors.outlineVariant}
          yAxisTextStyle={[styles.axisText, { color: theme.colors.onSurfaceVariant }]}
          xAxisLabelTextStyle={[styles.axisText, { color: theme.colors.onSurfaceVariant }]}
          labelWidth={labelWidth}
          barBorderRadius={2}
          disableScroll
          isAnimated={false}
        />
      ) : (
        <View style={{ height }} />
      )}

      {/* Legend doubles as the per-category total, so no hover is needed. */}
      <View style={styles.legend}>
        {CATEGORIES.map((category) => (
          <View key={category} style={styles.legendItem}>
            <View style={[styles.swatch, { backgroundColor: CATEGORY_COLORS[category] }]} />
            <Text variant="bodySmall">
              {LEGEND_LABELS[category]} {totals[category]}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: { gap: 8 },
  axisText: { fontSize: 11 },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  swatch: { width: 12, height: 12, borderRadius: 3 },
});
