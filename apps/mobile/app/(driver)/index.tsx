/**
 * Driver home (§2.3.6).
 *
 * Active rental card, emergency-contact card with a warning when missing, and
 * the SOS button (long-press 2 s so it cannot be triggered by a pocket).
 */
import React, { useCallback, useRef, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { Banner, Button, Card, Chip, Divider, Text, useTheme } from 'react-native-paper';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import * as Crypto from 'expo-crypto';

import { useActiveRental, useEmergencyContact } from '../../src/api/hooks/useIncidents';
import { api, ApiError } from '../../src/api/client';
import { FreshnessBadge } from '../../src/components/FreshnessBadge';
import { LeafletMap } from '../../src/components/LeafletMap';
import { StatusDot } from '../../src/components/StatusDot';
import { formatDateTime } from '../../src/lib/format';
import { EMERGENCY_RED, SAFE_GREEN, spacing } from '../../src/theme';

/** §2.3.6: long-press 2 s to avoid accidental taps. */
const SOS_HOLD_MS = 2000;

export default function DriverHome() {
  const theme = useTheme();
  const router = useRouter();
  const { t } = useTranslation();

  const activeRental = useActiveRental();
  const contact = useEmergencyContact();

  const [sosProgress, setSosProgress] = useState(0);
  const [sosError, setSosError] = useState<string | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const progressTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const rental = activeRental.data?.rental ?? null;

  const clearHold = useCallback(() => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    if (progressTimer.current) clearInterval(progressTimer.current);
    holdTimer.current = null;
    progressTimer.current = null;
    setSosProgress(0);
  }, []);

  const fireSos = useCallback(async () => {
    clearHold();
    setSosError(null);
    try {
      const result = await api.post<{ incidentId: string }>('/drivers/me/sos', {
        idempotencyKey: Crypto.randomUUID(),
      });
      router.push(`/emergency/${result.incidentId}` as never);
    } catch (error) {
      setSosError(error instanceof ApiError ? error.message : 'Could not send SOS.');
    }
  }, [clearHold, router]);

  const startHold = useCallback(() => {
    setSosProgress(0);
    const startedAt = Date.now();
    progressTimer.current = setInterval(() => {
      setSosProgress(Math.min(1, (Date.now() - startedAt) / SOS_HOLD_MS));
    }, 50);
    holdTimer.current = setTimeout(() => void fireSos(), SOS_HOLD_MS);
  }, [fireSos]);

  const refreshing = activeRental.isFetching || contact.isFetching;

  return (
    <ScrollView
      contentContainerStyle={styles.container}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            void activeRental.refetch();
            void contact.refetch();
          }}
        />
      }
    >
      {/* §2.3.6: the contact warning outranks everything else on this screen. */}
      {contact.data === null ? (
        <Banner
          visible
          icon="alert"
          actions={[{ label: t('driver.contact'), onPress: () => router.push('/(driver)/contact' as never) }]}
        >
          {t('driver.contactMissing')}
        </Banner>
      ) : null}

      {rental ? (
        <Card mode="elevated">
          <Card.Title
            title={rental.bike.label}
            subtitle={`${t('driver.activeRental')} · ${rental.ownerName}`}
            right={() => (
              <View style={styles.cardRight}>
                <StatusDot state={rental.bike.deviceOnline} />
              </View>
            )}
          />
          <Card.Content style={styles.cardContent}>
            <View style={styles.row}>
              <Chip compact icon={rental.bike.ignition.state === 'ON' ? 'key' : 'key-outline'}>
                {rental.bike.ignition.state}
              </Chip>
              <FreshnessBadge location={rental.bike.location} compact />
            </View>

            {/* FR-DRV-02: when this ride started, in Colombo time. */}
            {rental.startedAt ? (
              <Text variant="bodyMedium">{t('driver.startedAt', { time: formatDateTime(rental.startedAt) })}</Text>
            ) : null}

            <View style={styles.row}>
              <Text variant="bodyMedium">{t('driver.tripDistance')}</Text>
              <Text variant="titleMedium">{(rental.distanceM / 1000).toFixed(2)} km</Text>
            </View>

            <Divider />

            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
              {rental.bike.deviceOnline === 'ONLINE'
                ? t('driver.bikeConnected')
                : t('driver.bikeNotReporting')}
            </Text>

            {rental.bike.location.lat !== null && rental.bike.location.lon !== null ? (
              <LeafletMap
                height={180}
                markers={[
                  {
                    id: rental.id,
                    lat: rental.bike.location.lat,
                    lon: rental.bike.location.lon,
                    label: rental.bike.label,
                    color: SAFE_GREEN,
                  },
                ]}
              />
            ) : null}
          </Card.Content>
        </Card>
      ) : (
        <Card mode="outlined">
          <Card.Content>
            <Text variant="titleMedium">{t('driver.noActiveRental')}</Text>
          </Card.Content>
        </Card>
      )}

      <Card mode="outlined">
        <Card.Title title={t('driver.contact')} left={() => <StatusDot state={contact.data ? 'ONLINE' : 'OFFLINE'} />} />
        <Card.Content>
          {contact.data ? (
            <>
              <Text variant="titleMedium">{contact.data.name}</Text>
              <Text variant="bodyMedium">{contact.data.phone}</Text>
              <Text variant="bodySmall">{contact.data.relationship}</Text>
            </>
          ) : (
            <Text variant="bodyMedium">{t('driver.contactMissing')}</Text>
          )}
        </Card.Content>
      </Card>

      {/* §2.3.6 SOS: nice-to-have; the bike's physical button is the Must. */}
      {rental ? (
        <Card mode="outlined" style={{ borderColor: EMERGENCY_RED }}>
          <Card.Content style={styles.cardContent}>
            <Button
              mode="contained"
              buttonColor={EMERGENCY_RED}
              textColor="#FFFFFF"
              icon="alert-octagon"
              onPressIn={startHold}
              onPressOut={clearHold}
              contentStyle={styles.sosContent}
              labelStyle={styles.sosLabel}
            >
              {t('driver.sos')}
            </Button>
            <Text variant="bodySmall" style={styles.center}>
              {sosProgress > 0 ? `${Math.round(sosProgress * 100)}%` : t('driver.sosHold')}
            </Text>
            {sosError ? (
              <Text variant="bodySmall" style={{ color: theme.colors.error }}>
                {sosError}
              </Text>
            ) : null}
          </Card.Content>
        </Card>
      ) : null}

      <Text variant="bodySmall" style={styles.disclaimer}>
        {t('emergency.notEmergencyService')}
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: spacing(2), gap: spacing(2) },
  cardContent: { gap: spacing(1.5) },
  cardRight: { paddingRight: spacing(2) },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  sosContent: { height: 72 },
  sosLabel: { fontSize: 20, fontWeight: '800' },
  center: { textAlign: 'center' },
  disclaimer: { textAlign: 'center', opacity: 0.7, marginTop: spacing(1) },
});
