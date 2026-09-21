/**
 * Assign rental (§2.4, FR-RENT-01/03).
 *
 * The sync states are the point of this screen. A rental is PENDING_SYNC until
 * the bike acks the assignment, and only then does it hold the phone numbers it
 * would text after a crash. So:
 *
 *   Waiting for bike to confirm… (spinner + elapsed)
 *   -> Active ✓ (bike acknowledged at 10:02:11)
 *   -> after 60 s: "Bike has not confirmed. It may be offline."
 *      with Keep waiting / Cancel / (demo only) Force activate, in red.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ActivityIndicator, Button, Card, Chip, Text, TextInput, useTheme } from 'react-native-paper';
import { useTranslation } from 'react-i18next';
import * as Crypto from 'expo-crypto';

import {
  useAssignRental,
  useCancelRental,
  useDriverLookup,
  useForceActivate,
  useRental,
} from '../../../../src/api/hooks/useBikes';
import { ApiError } from '../../../../src/api/client';
import { EMERGENCY_RED, SAFE_GREEN, spacing } from '../../../../src/theme';

/** §2.4: after this long with no ack, offer the escape hatches. */
const ACK_PATIENCE_MS = 60_000;

const formatTime = (iso: string | null | undefined): string =>
  iso
    ? new Date(iso).toLocaleTimeString('en-GB', {
        timeZone: 'Asia/Colombo',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : '';

export default function AssignRental() {
  const { id: bikeId } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const theme = useTheme();
  const { t } = useTranslation();

  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [rentalId, setRentalId] = useState<string | null>(null);
  const [startedWaitingAt, setStartedWaitingAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const lookup = useDriverLookup(query, searching);
  const assign = useAssignRental();
  const cancel = useCancelRental();
  const forceActivate = useForceActivate();

  // Poll the rental while we wait for the bike; the socket also invalidates it.
  const rental = useRental(rentalId ?? undefined, Boolean(rentalId));

  useEffect(() => {
    if (!startedWaitingAt) return;
    const timer = setInterval(() => setElapsed(Date.now() - startedWaitingAt), 500);
    return () => clearInterval(timer);
  }, [startedWaitingAt]);

  const state = rental.data?.state;
  const waitedTooLong = elapsed > ACK_PATIENCE_MS && state === 'PENDING_SYNC';

  const driver = lookup.data;
  const canAssign = Boolean(driver && driver.hasEmergencyContact && !driver.busy);

  const blockReason = useMemo(() => {
    if (!driver) return null;
    // FR-RENT-01: no contact means nobody to text, so assignment is refused.
    if (!driver.hasEmergencyContact) return 'This rider has no emergency contact yet.';
    if (driver.busy) return 'This rider already has an open rental.';
    return null;
  }, [driver]);

  const onAssign = async (): Promise<void> => {
    if (!driver || !bikeId) return;
    setError(null);
    try {
      const result = await assign.mutateAsync({
        bikeId,
        driverId: driver.id,
        idempotencyKey: Crypto.randomUUID(),
      });
      setRentalId(result.id);
      setStartedWaitingAt(Date.now());
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.code === 'NO_EMERGENCY_CONTACT'
            ? 'This rider has no emergency contact yet.'
            : caught.code === 'DRIVER_BUSY'
              ? 'This rider already has an open rental.'
              : caught.code === 'RENTAL_ACTIVE_EXISTS'
                ? 'This bike already has an open rental.'
                : caught.message
          : t('common.error'),
      );
    }
  };

  // --- waiting / active state ---------------------------------------------
  if (rentalId) {
    return (
      <ScrollView contentContainerStyle={styles.container}>
        <Card mode="elevated">
          <Card.Content style={styles.section}>
            {state === 'ACTIVE' ? (
              <>
                <Chip icon="check-circle" style={{ backgroundColor: SAFE_GREEN }} textStyle={styles.chipText}>
                  {rental.data?.demoOverride
                    ? 'Active · demo override (bike never confirmed)'
                    : t('owner.bikeAcknowledged', { time: formatTime(rental.data?.sync.deviceAckAt) })}
                </Chip>
                <Button mode="contained" onPress={() => router.replace(`/(owner)/bikes/${bikeId}` as never)}>
                  {t('common.close')}
                </Button>
              </>
            ) : (
              <>
                <View style={styles.waitRow}>
                  <ActivityIndicator />
                  <Text variant="titleMedium">{t('owner.waitingForBike')}</Text>
                </View>
                <Text variant="bodySmall">{Math.round(elapsed / 1000)}s elapsed</Text>

                {waitedTooLong ? (
                  <>
                    <Text variant="bodyMedium" style={{ color: theme.colors.error }}>
                      {t('owner.bikeNotConfirmed')}
                    </Text>

                    <Button mode="outlined" onPress={() => setStartedWaitingAt(Date.now())}>
                      {t('owner.keepWaiting')}
                    </Button>

                    <Button
                      mode="outlined"
                      onPress={() => {
                        cancel.mutate(rentalId, {
                          onSuccess: () => router.replace(`/(owner)/bikes/${bikeId}` as never),
                        });
                      }}
                      loading={cancel.isPending}
                    >
                      {t('common.cancel')}
                    </Button>

                    {/* FR-RENT-03: demo only, and the label says what it costs. */}
                    <Button
                      mode="contained"
                      buttonColor={EMERGENCY_RED}
                      textColor="#FFFFFF"
                      icon="alert"
                      onPress={() => forceActivate.mutate(rentalId)}
                      loading={forceActivate.isPending}
                    >
                      {t('owner.forceActivate')}
                    </Button>
                    <Text variant="bodySmall" style={{ color: theme.colors.error }}>
                      Force activate marks the ride active even though the bike never confirmed it
                      holds the rider’s emergency numbers. Demo builds only.
                    </Text>
                  </>
                ) : null}
              </>
            )}
          </Card.Content>
        </Card>
      </ScrollView>
    );
  }

  // --- lookup --------------------------------------------------------------
  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Card mode="outlined">
        <Card.Title title="Find rider" subtitle="Exact phone or email" />
        <Card.Content style={styles.section}>
          <TextInput
            label="Phone or email"
            value={query}
            onChangeText={(value) => {
              setQuery(value);
              setSearching(false);
            }}
            mode="outlined"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Button mode="contained-tonal" onPress={() => setSearching(true)} disabled={query.trim().length < 3}>
            Search
          </Button>

          {searching && lookup.isLoading ? <ActivityIndicator /> : null}

          {searching && lookup.isError ? (
            <Text variant="bodySmall">No rider found with that exact phone or email.</Text>
          ) : null}

          {driver ? (
            <Card mode="contained">
              <Card.Content style={styles.section}>
                <Text variant="titleMedium">{driver.name}</Text>
                {/* §5.7.3: the lookup only ever returns a masked number. */}
                <Text variant="bodySmall">{driver.phoneMasked}</Text>
                <Chip
                  compact
                  icon={driver.hasEmergencyContact ? 'check' : 'close'}
                  style={{
                    backgroundColor: driver.hasEmergencyContact ? SAFE_GREEN : EMERGENCY_RED,
                  }}
                  textStyle={styles.chipText}
                >
                  {driver.hasEmergencyContact ? 'has emergency contact' : 'no emergency contact'}
                </Chip>
                {blockReason ? (
                  <Text variant="bodySmall" style={{ color: theme.colors.error }}>
                    {blockReason}
                  </Text>
                ) : null}
              </Card.Content>
            </Card>
          ) : null}

          <Button
            mode="contained"
            onPress={() => void onAssign()}
            loading={assign.isPending}
            disabled={!canAssign || assign.isPending}
          >
            {t('common.confirm')}
          </Button>

          {error ? (
            <Text variant="bodySmall" style={{ color: theme.colors.error }}>
              {error}
            </Text>
          ) : null}
        </Card.Content>
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: spacing(2), gap: spacing(1.5) },
  section: { gap: spacing(1) },
  waitRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  chipText: { color: '#FFFFFF', fontSize: 11 },
});
