/**
 * StatusDot (§2.3.3) - device online state as a colour.
 *
 * ONLINE green, STALE amber, OFFLINE red. "Stale" is its own colour because it
 * is a real, distinct state: the bike reported recently but not recently
 * enough to trust the position as live.
 */
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';
import { HEALTH_COLORS } from '../theme';

export interface StatusDotProps {
  state: string;
  showLabel?: boolean;
  size?: number;
}

const colorFor = (state: string): string => {
  switch (state) {
    case 'ONLINE':
      return HEALTH_COLORS.ok;
    case 'STALE':
      return HEALTH_COLORS.degraded;
    default:
      return HEALTH_COLORS.down;
  }
};

export const StatusDot: React.FC<StatusDotProps> = ({ state, showLabel = false, size = 12 }) => (
  <View style={styles.row}>
    <View
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: colorFor(state) }}
    />
    {showLabel ? <Text variant="bodySmall">{state}</Text> : null}
  </View>
);

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
});
