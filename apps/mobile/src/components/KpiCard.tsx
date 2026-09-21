/** KpiCard (§2.3.6) - one of the 2x2 dashboard tiles. */
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Card, Text } from 'react-native-paper';

export interface KpiCardProps {
  label: string;
  value: string | number;
  hint?: string;
  color?: string;
  onPress?: () => void;
}

export const KpiCard: React.FC<KpiCardProps> = ({ label, value, hint, color, onPress }) => (
  <Card mode="outlined" style={styles.card} onPress={onPress}>
    <Card.Content style={styles.content}>
      <Text variant="labelMedium" numberOfLines={1}>
        {label}
      </Text>
      <View style={styles.valueRow}>
        <Text variant="headlineMedium" style={[styles.value, color ? { color } : null]}>
          {value}
        </Text>
      </View>
      {hint ? (
        <Text variant="bodySmall" numberOfLines={1}>
          {hint}
        </Text>
      ) : null}
    </Card.Content>
  </Card>
);

const styles = StyleSheet.create({
  card: { flex: 1, minWidth: '45%' },
  content: { gap: 2 },
  valueRow: { flexDirection: 'row', alignItems: 'baseline' },
  value: { fontWeight: '800' },
});
