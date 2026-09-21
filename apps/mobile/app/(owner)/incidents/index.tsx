/** Incident list (§2.3.4 historical tracking) with category filters. */
import React, { useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Card, Chip, SegmentedButtons, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { useIncidents } from '../../../src/api/hooks/useIncidents';
import { CATEGORY_COLORS, EMERGENCY_RED, SAFE_GREEN, SECURITY_AMBER, spacing } from '../../../src/theme';
import { severityApplies } from '../../../src/lib/format';

const severityColor = (label: string): string =>
  label === 'HIGH' || label === 'SOS' ? EMERGENCY_RED : label === 'MODERATE' ? SECURITY_AMBER : SAFE_GREEN;

export default function IncidentList() {
  const router = useRouter();
  const { t } = useTranslation();
  const [category, setCategory] = useState<string>('');

  const incidents = useIncidents(category ? { category } : {});

  return (
    <ScrollView
      contentContainerStyle={styles.container}
      refreshControl={
        <RefreshControl refreshing={incidents.isFetching} onRefresh={() => void incidents.refetch()} />
      }
    >
      <SegmentedButtons
        value={category}
        onValueChange={setCategory}
        buttons={[
          { value: '', label: 'All' },
          { value: 'EMERGENCY', label: 'Emergency' },
          { value: 'SECURITY', label: 'Security' },
          { value: 'INFO', label: 'Info' },
        ]}
      />

      {(incidents.data ?? []).map((incident) => (
        <Card
          key={incident.id}
          mode="outlined"
          onPress={() => router.push(`/(owner)/incidents/${incident.id}` as never)}
        >
          <Card.Content style={styles.card}>
            {/* Appendix D label, verbatim. */}
            <Text variant="titleSmall">{incident.label}</Text>

            <View style={styles.row}>
              <Chip
                compact
                style={{ backgroundColor: CATEGORY_COLORS[incident.category] }}
                textStyle={styles.chipText}
              >
                {incident.category}
              </Chip>
              {severityApplies(incident.severity) ? (
                <Chip
                  compact
                  style={{ backgroundColor: severityColor(incident.severity.label) }}
                  textStyle={styles.chipText}
                >
                  {incident.severity.label}
                </Chip>
              ) : null}
              <Chip compact>{incident.state}</Chip>
              {incident.quarantined ? (
                <Chip compact icon="alert">
                  quarantined
                </Chip>
              ) : null}
              {incident.isDemo ? (
                <Chip compact icon="flask">
                  demo
                </Chip>
              ) : null}
            </View>

            <Text variant="bodySmall">
              {incident.bikeLabel} ·{' '}
              {new Date(incident.occurredAt).toLocaleString('en-GB', {
                timeZone: 'Asia/Colombo',
                day: '2-digit',
                month: 'short',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </Text>
          </Card.Content>
        </Card>
      ))}

      {(incidents.data ?? []).length === 0 && !incidents.isLoading ? (
        <Text variant="bodySmall">{t('common.empty')}</Text>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: spacing(2), gap: spacing(1.5) },
  card: { gap: 6 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chipText: { color: '#FFFFFF', fontSize: 11 },
});
