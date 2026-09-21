/**
 * ChartCard and EmptyChart - the frame every chart sits in.
 *
 * An empty chart is not a blank box. It says what *will* appear there and
 * what makes it appear, so an owner with a new fleet learns what the screen is
 * for instead of wondering whether it is broken.
 */
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { ActivityIndicator, Card, Text, useTheme } from 'react-native-paper';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { spacing } from '../../theme';

export interface EmptyChartProps {
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  /** One line: what is missing. */
  title: string;
  /** What will show here, and what produces it. */
  explanation: string;
}

export const EmptyChart: React.FC<EmptyChartProps> = ({ icon, title, explanation }) => {
  const theme = useTheme();
  return (
    <View style={styles.empty} accessibilityRole="text" accessibilityLabel={`${title}. ${explanation}`}>
      <MaterialCommunityIcons name={icon} size={32} color={theme.colors.onSurfaceVariant} />
      <Text variant="titleSmall" style={styles.emptyTitle}>
        {title}
      </Text>
      <Text variant="bodySmall" style={[styles.emptyText, { color: theme.colors.onSurfaceVariant }]}>
        {explanation}
      </Text>
    </View>
  );
};

export interface ChartCardProps {
  title: string;
  subtitle?: string;
  /** A one-line takeaway under the title, e.g. "12 in 14 days". */
  summary?: string;
  loading?: boolean;
  error?: boolean;
  onRetry?: () => void;
  empty?: EmptyChartProps | null;
  children?: React.ReactNode;
}

export const ChartCard: React.FC<ChartCardProps> = ({
  title,
  subtitle,
  summary,
  loading,
  error,
  onRetry,
  empty,
  children,
}) => {
  const theme = useTheme();

  let body: React.ReactNode;
  if (loading) {
    body = (
      <View style={styles.loading}>
        <ActivityIndicator />
      </View>
    );
  } else if (error) {
    body = (
      <EmptyChart
        icon="cloud-off-outline"
        title="Could not load this chart"
        explanation={onRetry ? 'Pull down to try again.' : 'Check your connection and try again.'}
      />
    );
  } else if (empty) {
    body = <EmptyChart {...empty} />;
  } else {
    body = children;
  }

  return (
    <Card mode="outlined">
      <Card.Title title={title} subtitle={subtitle} titleVariant="titleMedium" />
      <Card.Content style={styles.content}>
        {summary && !loading && !error && !empty ? (
          <Text variant="bodyMedium" style={{ color: theme.colors.onSurface }}>
            {summary}
          </Text>
        ) : null}
        {body}
      </Card.Content>
    </Card>
  );
};

const styles = StyleSheet.create({
  content: { gap: spacing(1.5) },
  loading: { height: 120, alignItems: 'center', justifyContent: 'center' },
  empty: { alignItems: 'center', paddingVertical: spacing(2), paddingHorizontal: spacing(1), gap: 6 },
  emptyTitle: { textAlign: 'center' },
  emptyText: { textAlign: 'center', lineHeight: 18 },
});
