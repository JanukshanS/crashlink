/**
 * Emergency contact (§2.3.6, FR-DRV-01, FR-DRV-04).
 *
 * The one thing this screen must get right is the message after saving during
 * an active rental: the bike keeps the number it was given when the ride
 * started, so a new one applies to the NEXT rental. The API says which case
 * applies via `appliesTo`, and we repeat that rather than guessing.
 */
import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { Banner, Button, Card, HelperText, Text, TextInput, useTheme } from 'react-native-paper';
import { useTranslation } from 'react-i18next';
import { parsePhoneNumberFromString } from 'libphonenumber-js';

import { useEmergencyContact, useSaveEmergencyContact } from '../../src/api/hooks/useIncidents';
import { ApiError } from '../../src/api/client';
import { spacing } from '../../src/theme';

export default function EmergencyContactScreen() {
  const theme = useTheme();
  const { t } = useTranslation();
  const contact = useEmergencyContact();
  const save = useSaveEmergencyContact();

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [relationship, setRelationship] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!contact.data) return;
    setName(contact.data.name);
    setPhone(contact.data.phone);
    setRelationship(contact.data.relationship);
  }, [contact.data]);

  // §2.3.1: normalised to E.164 with libphonenumber-js, defaulting to LK.
  const normalised = parsePhoneNumberFromString(phone, 'LK');
  const phoneValid = Boolean(normalised?.isValid());

  const onSave = async (): Promise<void> => {
    setNotice(null);
    setError(null);
    if (!phoneValid || !normalised) return;

    try {
      const result = await save.mutateAsync({
        name: name.trim(),
        phone: normalised.number,
        relationship: relationship.trim(),
      });
      setNotice(
        result.appliesTo === 'NEXT_RENTAL'
          ? t('driver.contactAppliesNext')
          : 'Emergency contact saved.',
      );
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('common.error'));
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      {contact.data === null ? (
        <Banner visible icon="alert">
          {t('driver.contactMissing')}
        </Banner>
      ) : null}

      {notice ? (
        <Banner
          visible
          icon="information"
          actions={[{ label: t('common.close'), onPress: () => setNotice(null) }]}
        >
          {notice}
        </Banner>
      ) : null}

      <Card mode="outlined">
        <Card.Content style={styles.form}>
          <TextInput
            label="Name"
            value={name}
            onChangeText={setName}
            mode="outlined"
            autoCapitalize="words"
          />

          <TextInput
            label={t('auth.phone')}
            value={phone}
            onChangeText={setPhone}
            mode="outlined"
            keyboardType="phone-pad"
            autoComplete="tel"
          />
          <HelperText type={phone.length === 0 || phoneValid ? 'info' : 'error'} visible>
            {phone.length === 0
              ? 'The bike will text this number if you do not answer.'
              : phoneValid
                ? normalised!.number
                : 'Enter a valid phone number'}
          </HelperText>

          <TextInput
            label="Relationship"
            value={relationship}
            onChangeText={setRelationship}
            mode="outlined"
            placeholder="Mother, brother, friend…"
          />

          {error ? (
            <Text variant="bodySmall" style={{ color: theme.colors.error }}>
              {error}
            </Text>
          ) : null}

          <Button
            mode="contained"
            onPress={() => void onSave()}
            loading={save.isPending}
            disabled={
              save.isPending ||
              !phoneValid ||
              name.trim().length < 2 ||
              relationship.trim().length < 2
            }
          >
            {t('common.save')}
          </Button>
        </Card.Content>
      </Card>

      <Text variant="bodySmall" style={styles.note}>
        This number receives an SMS from the bike if you do not answer the safety check.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: spacing(2), gap: spacing(2) },
  form: { gap: spacing(1) },
  note: { opacity: 0.7, textAlign: 'center' },
});
