/** Driver history (§2.3.6, FR-DRV-03): own rentals and own incidents, no photos. */
import React from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { Card, Chip, Divider, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { useDriverIncidents, useDriverRentals } from '../../src/api/hooks/useIncidents';
import { CATEGORY_COLORS, spacing } from '../../src/theme';

const formatDate = (iso: string | null): string =>
  iso
    ? new Date(iso).toLocaleString('en-GB', {
        timeZone: 'Asia/Colombo',
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

export default function DriverHistory() {
  const { t } = useTranslation();
  const rentals = useDriverRentals();
  const incidents = useDriverIncidents();

  return (
    <ScrollView
      contentContainerStyle={styles.container}
      refreshControl={
        <RefreshControl
          refreshing={rentals.isFetching || incidents.isFetching}
          onRefresh={() => {
            void rentals.refetch();
            void incidents.refetch();
          }}
        />
      }
    >
      <Text variant="titleMedium">Rides</Text>
      {(rentals.data ?? []).length === 0 ? (
        <Text variant="bodySmall">{t('common.empty')}</Text>
      ) : (
        (rentals.data ?? []).map((rental) => (
          <Card key={rental.id} mode="outlined">
            <Card.Content>
              <Text variant="titleSmall">{rental.bikeLabel}</Text>
              <Text variant="bodySmall">
                {formatDate(rental.startedAt)} → {formatDate(rental.endedAt)}
              </Text>
              <View style={styles.row}>
                <Text variant="bodySmall">{(rental.distanceM / 1000).toFixed(2)} km</Text>
                <Text variant="bodySmall">{rental.incidentCount} events</Text>
              </View>
            </Card.Content>
          </Card>
        ))
      )}

      <Divider style={styles.divider} />

      <Text variant="titleMedium">Events</Text>
      {(incidents.data ?? []).length === 0 ? (
        <Text variant="bodySmall">{t('common.empty')}</Text>
      ) : (
        (incidents.data ?? []).map((incident) => (
          <Card key={incident.id} mode="outlined">
            <Card.Content style={styles.incidentContent}>
              {/* Appendix D label, verbatim from the API: "Possible …". */}
              <Text variant="titleSmall">{incident.label}</Text>
              <View style={styles.row}>
                <Chip
                  compact
                  style={{ backgroundColor: CATEGORY_COLORS[incident.category] }}
                  textStyle={styles.chipText}
                >
                  {incident.category}
                </Chip>
                <Text variant="bodySmall">{formatDate(incident.occurredAt)}</Text>
              </View>
              <Text variant="bodySmall">
                {incident.bikeLabel} · {incident.state}
              </Text>
            </Card.Content>
          </Card>
        ))
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: spacing(2), gap: spacing(1.5) },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  incidentContent: { gap: 6 },
  chipText: { color: '#FFFFFF', fontSize: 11 },
  divider: { marginVertical: spacing(1) },
});
