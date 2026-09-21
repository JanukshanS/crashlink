/**
 * Add bike + pair device (§2.3.2, FR-DEV-02).
 *
 * Two steps in one screen: create the bike, then pair it with the code pair the
 * admin printed. Pairing is rate-limited server-side (5/min), so a wrong code
 * is reported plainly rather than retried in a loop.
 */
import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { Button, Card, HelperText, Text, TextInput, useTheme } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { useCreateBike, usePairDevice } from '../../../src/api/hooks/useBikes';
import { ApiError } from '../../../src/api/client';
import { spacing } from '../../../src/theme';

export default function AddBike() {
  const router = useRouter();
  const theme = useTheme();
  const { t } = useTranslation();

  const createBike = useCreateBike();
  const [bikeId, setBikeId] = useState<string | null>(null);
  const pair = usePairDevice(bikeId ?? '');

  const [label, setLabel] = useState('');
  const [plateNo, setPlateNo] = useState('');
  const [deviceCode, setDeviceCode] = useState('');
  const [pairingCode, setPairingCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  const onCreate = async (): Promise<void> => {
    setError(null);
    try {
      const bike = await createBike.mutateAsync({
        label: label.trim(),
        ...(plateNo.trim() ? { plateNo: plateNo.trim() } : {}),
      });
      setBikeId(bike.id);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('common.error'));
    }
  };

  const onPair = async (): Promise<void> => {
    setError(null);
    if (!bikeId) return;
    try {
      await pair.mutateAsync({
        deviceCode: deviceCode.trim().toUpperCase(),
        pairingCode: pairingCode.trim().toUpperCase(),
      });
      router.replace(`/(owner)/bikes/${bikeId}` as never);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.code === 'DEVICE_ALREADY_PAIRED'
            ? 'That device is already paired to another bike.'
            : caught.code === 'RATE_LIMITED'
              ? 'Too many attempts. Wait a minute and try again.'
              : 'Device code or pairing code is incorrect.'
          : t('common.error'),
      );
    }
  };

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.container}>
        <Card mode="outlined">
          <Card.Title title="1 · Bike" />
          <Card.Content style={styles.form}>
            <TextInput
              label="Label"
              value={label}
              onChangeText={setLabel}
              mode="outlined"
              placeholder="Scooter 1"
              disabled={Boolean(bikeId)}
            />
            <TextInput
              label="Plate number (optional)"
              value={plateNo}
              onChangeText={setPlateNo}
              mode="outlined"
              placeholder="WP BCD-1234"
              autoCapitalize="characters"
              disabled={Boolean(bikeId)}
            />
            {bikeId ? (
              <Text variant="bodySmall">Bike created ✓</Text>
            ) : (
              <Button
                mode="contained"
                onPress={() => void onCreate()}
                loading={createBike.isPending}
                disabled={createBike.isPending || label.trim().length < 1}
              >
                Create bike
              </Button>
            )}
          </Card.Content>
        </Card>

        <Card mode="outlined">
          <Card.Title title="2 · Pair device" subtitle="From the device label" />
          <Card.Content style={styles.form}>
            <TextInput
              label="Device code"
              value={deviceCode}
              onChangeText={setDeviceCode}
              mode="outlined"
              placeholder="CL-0001"
              autoCapitalize="characters"
              autoCorrect={false}
              disabled={!bikeId}
            />
            <TextInput
              label="Pairing code"
              value={pairingCode}
              onChangeText={setPairingCode}
              mode="outlined"
              placeholder="7H3K9QXA"
              autoCapitalize="characters"
              autoCorrect={false}
              disabled={!bikeId}
            />
            <HelperText type="info" visible>
              The pairing code is printed on the device label.
            </HelperText>

            <Button
              mode="contained"
              onPress={() => void onPair()}
              loading={pair.isPending}
              disabled={!bikeId || pair.isPending || deviceCode.length < 4 || pairingCode.length < 4}
            >
              {t('owner.pairDevice')}
            </Button>
          </Card.Content>
        </Card>

        {error ? (
          <Text variant="bodySmall" style={{ color: theme.colors.error }}>
            {error}
          </Text>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { padding: spacing(2), gap: spacing(2) },
  form: { gap: spacing(1) },
});
