/**
 * BlackBoxChart (FR-INC-12) - the incident's `sensorWindow` as four aligned
 * traces on one shared time axis: acceleration, rotation, tilt and speed.
 *
 * Why stacked panels rather than one chart: the four series are in different
 * units (g, °/s, °, km/h) spanning 0-4 up to 0-300. On a single y axis three
 * of them would be flat lines along the bottom. Separate panels, each with its
 * own scale, share the x axis exactly - so "tilt jumped 0.4 s after the
 * rotation spike" still reads straight down the page.
 *
 * Time is labelled relative to the event when the event falls inside the
 * window (negative = before), which is the question an owner is asking.
 */
import React, { useMemo, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Line, Path, Rect, Text as SvgText } from 'react-native-svg';
import { Text, useTheme } from 'react-native-paper';
import type { SensorWindow } from '@crashlink/contracts';
import { EMERGENCY_RED, INFO_BLUE, SECURITY_AMBER } from '../theme';
import { EmptyChart } from './charts/ChartCard';

const GUTTER = 40;
const RIGHT = 8;
const PANEL_HEIGHT = 56;
const AXIS_HEIGHT = 24;

interface Series {
  key: 'a' | 'g' | 'tilt' | 'spd';
  title: string;
  unit: string;
  color: string;
  decimals: number;
}

const SERIES: Series[] = [
  { key: 'a', title: 'Acceleration', unit: 'g', color: EMERGENCY_RED, decimals: 1 },
  { key: 'g', title: 'Rotation', unit: '°/s', color: '#7B4FB8', decimals: 0 },
  { key: 'tilt', title: 'Tilt', unit: '°', color: SECURITY_AMBER, decimals: 0 },
  { key: 'spd', title: 'Speed', unit: 'km/h', color: INFO_BLUE, decimals: 0 },
];

/** A tick step that yields 3-6 labels across the window. */
const tickStep = (durationSec: number): number => {
  for (const step of [0.2, 0.5, 1, 2, 5, 10, 15, 30, 60]) {
    if (durationSec / step <= 6) return step;
  }
  return 120;
};

const fmt = (value: number, decimals: number): string =>
  Number.isFinite(value) ? value.toFixed(decimals) : '—';

export interface BlackBoxChartProps {
  sensorWindow: SensorWindow | null | undefined;
  /** The incident's occurredAt, drawn as the red event marker. */
  occurredAt: string;
  simulated?: boolean;
}

export const BlackBoxChart: React.FC<BlackBoxChartProps> = ({ sensorWindow, occurredAt, simulated }) => {
  const theme = useTheme();
  const [width, setWidth] = useState(0);

  const onLayout = (event: LayoutChangeEvent): void => {
    const next = Math.floor(event.nativeEvent.layout.width);
    if (next !== width) setWidth(next);
  };

  const model = useMemo(() => {
    if (!sensorWindow || !(sensorWindow.hz > 0)) return null;

    const lengths = SERIES.map((series) => sensorWindow[series.key]?.length ?? 0);
    const samples = Math.max(0, ...lengths);
    if (samples === 0) return null;

    const hz = sensorWindow.hz;
    // A single sample still needs a width to draw its dot.
    const durationSec = Math.max((samples - 1) / hz, 1 / hz);

    const t0 = Date.parse(sensorWindow.t0);
    const eventSec = Number.isNaN(t0) ? null : (Date.parse(occurredAt) - t0) / 1000;
    const eventInWindow = eventSec !== null && eventSec >= 0 && eventSec <= durationSec;

    return { hz, samples, durationSec, eventSec: eventInWindow ? eventSec : null };
  }, [sensorWindow, occurredAt]);

  if (!model || !sensorWindow) {
    return (
      <EmptyChart
        icon="chart-timeline-variant"
        title="No sensor recording for this event"
        explanation="When the bike detects a fall it attaches a few seconds of acceleration, rotation, tilt and speed from around the moment. That trace appears here."
      />
    );
  }

  const plotWidth = Math.max(0, width - GUTTER - RIGHT);
  const x = (sec: number): number => GUTTER + (sec / model.durationSec) * plotWidth;

  const step = tickStep(model.durationSec);
  const origin = model.eventSec ?? 0;
  const ticks: number[] = [];
  // Ticks are placed on round values relative to the event (or window start).
  const firstTick = Math.ceil((0 - origin) / step) * step;
  for (let rel = firstTick; origin + rel <= model.durationSec + 1e-9; rel += step) {
    ticks.push(Math.round(rel * 100) / 100);
  }

  return (
    <View onLayout={onLayout} style={styles.container}>
      {width > 0
        ? SERIES.map((series) => {
            const values = sensorWindow[series.key] ?? [];
            const finite = values.filter((value) => Number.isFinite(value));
            const hasData = finite.length > 0;

            const peak = hasData ? Math.max(...finite) : 0;
            const low = hasData ? Math.min(0, ...finite) : 0;
            const high = peak > low ? peak : low + 1;
            const y = (value: number): number =>
              PANEL_HEIGHT - 4 - ((value - low) / (high - low)) * (PANEL_HEIGHT - 8);

            let path = '';
            values.forEach((value, index) => {
              if (!Number.isFinite(value)) return;
              const px = x(index / model.hz);
              path += `${path ? 'L' : 'M'}${px.toFixed(1)},${y(value).toFixed(1)}`;
            });

            return (
              <View key={series.key} style={styles.panel}>
                <View style={styles.panelHeader}>
                  <View style={[styles.swatch, { backgroundColor: series.color }]} />
                  <Text variant="labelLarge">{series.title}</Text>
                  <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                    {hasData ? `peak ${fmt(peak, series.decimals)} ${series.unit}` : 'not recorded'}
                  </Text>
                </View>

                <Svg width={width} height={PANEL_HEIGHT}>
                  <Rect
                    x={GUTTER}
                    y={0}
                    width={plotWidth}
                    height={PANEL_HEIGHT}
                    fill={theme.colors.surfaceVariant}
                    opacity={0.35}
                    rx={4}
                  />
                  {/* y range labels: this panel's own scale. */}
                  <SvgText x={GUTTER - 4} y={11} fontSize={10} fill={theme.colors.onSurfaceVariant} textAnchor="end">
                    {fmt(high, series.decimals)}
                  </SvgText>
                  <SvgText x={GUTTER - 4} y={PANEL_HEIGHT - 2} fontSize={10} fill={theme.colors.onSurfaceVariant} textAnchor="end">
                    {fmt(low, series.decimals)}
                  </SvgText>

                  {model.eventSec !== null ? (
                    <Line
                      x1={x(model.eventSec)}
                      x2={x(model.eventSec)}
                      y1={0}
                      y2={PANEL_HEIGHT}
                      stroke={EMERGENCY_RED}
                      strokeWidth={1.5}
                      strokeDasharray="4,3"
                    />
                  ) : null}

                  {path ? (
                    <Path d={path} stroke={series.color} strokeWidth={2} fill="none" strokeLinejoin="round" />
                  ) : null}

                  {/* A lone sample is a dot, not an invisible zero-length line. */}
                  {finite.length === 1
                    ? values.map((value, index) =>
                        Number.isFinite(value) ? (
                          <Rect
                            key={index}
                            x={x(index / model.hz) - 2.5}
                            y={y(value) - 2.5}
                            width={5}
                            height={5}
                            rx={2.5}
                            fill={series.color}
                          />
                        ) : null,
                      )
                    : null}
                </Svg>
              </View>
            );
          })
        : null}

      {/* The one shared time axis under all four panels. */}
      {width > 0 ? (
        <Svg width={width} height={AXIS_HEIGHT}>
          <Line
            x1={GUTTER}
            x2={GUTTER + plotWidth}
            y1={2}
            y2={2}
            stroke={theme.colors.outlineVariant}
            strokeWidth={1}
          />
          {ticks.map((rel) => {
            const px = x(origin + rel);
            const label =
              model.eventSec !== null
                ? rel === 0
                  ? 'event'
                  : `${rel > 0 ? '+' : ''}${rel}s`
                : `${rel}s`;
            return (
              <React.Fragment key={rel}>
                <Line x1={px} x2={px} y1={2} y2={6} stroke={theme.colors.outlineVariant} />
                <SvgText
                  x={px}
                  y={18}
                  fontSize={11}
                  fill={rel === 0 && model.eventSec !== null ? EMERGENCY_RED : theme.colors.onSurfaceVariant}
                  textAnchor="middle"
                >
                  {label}
                </SvgText>
              </React.Fragment>
            );
          })}
        </Svg>
      ) : null}

      <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
        {model.samples} samples at {model.hz} Hz ·{' '}
        {model.eventSec !== null
          ? 'dashed red line marks the reported event time'
          : 'event time falls outside this recording'}
        {simulated ? ' · simulated event' : ''}
      </Text>
    </View>
  );
};

const styles = StyleSheet.create({
  container: { gap: 8 },
  panel: { gap: 4 },
  panelHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: GUTTER },
  swatch: { width: 10, height: 10, borderRadius: 2 },
});
