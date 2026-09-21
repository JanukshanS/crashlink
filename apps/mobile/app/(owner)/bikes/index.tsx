/** Bike list (§2.2). GUEST sees it read-only, so "Add bike" is hidden (§2.1). */
import React from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Card, FAB, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { useBikes } from '../../../src/api/hooks/useBikes';
import { useIsReadOnly } from '../../../src/stores/auth';
import { StatusDot } from '../../../src/components/StatusDot';
import { FreshnessBadge } from '../../../src/components/FreshnessBadge';
import { spacing } from '../../../src/theme';

export default function BikeList() {
  const router = useRouter();
  const { t } = useTranslation();
  const bikes = useBikes();
  const readOnly = useIsReadOnly();

  return (
    <View style={styles.flex}>
      <ScrollView
        contentContainerStyle={styles.container}
        refreshControl={<RefreshControl refreshing={bikes.isFetching} onRefresh={() => void bikes.refetch()} />}
      >
        {(bikes.data ?? []).map((bike) => (
          <Card key={bike.id} mode="outlined" onPress={() => router.push(`/(owner)/bikes/${bike.id}` as never)}>
            <Card.Content style={styles.row}>
              <View style={styles.main}>
                <View style={styles.rowGap}>
                  <StatusDot state={bike.device?.online ?? 'OFFLINE'} />
                  <Text variant="titleSmall">{bike.label}</Text>
                </View>
                <Text variant="bodySmall">
                  {bike.plateNo ?? 'No plate'} · {bike.status}
                </Text>
                <Text variant="bodySmall">
                  {bike.device ? `${bike.device.code}` : 'No device paired'}
                  {bike.device?.configPending ? ' · config pending sync' : ''}
                </Text>
              </View>
              <FreshnessBadge location={bike.location} compact />
            </Card.Content>
          </Card>
        ))}

        {(bikes.data ?? []).length === 0 && !bikes.isLoading ? (
          <Text variant="bodySmall">{t('common.empty')}</Text>
        ) : null}
      </ScrollView>

      {/* §2.1: no mutation controls for the read-only judge account. */}
      {readOnly ? null : (
        <FAB
          icon="plus"
          label={t('owner.addBike')}
          style={styles.fab}
          onPress={() => router.push('/(owner)/bikes/add' as never)}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { padding: spacing(2), gap: spacing(1.5), paddingBottom: 96 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  main: { flex: 1, gap: 4 },
  rowGap: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  fab: { position: 'absolute', right: 16, bottom: 16 },
});
