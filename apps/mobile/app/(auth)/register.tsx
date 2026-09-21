/**
 * Register (§2.3.1, FR-AUTH-01).
 *
 * Validated with the same zod schema the API uses (`RegisterRequestSchema`
 * from packages/contracts), so the client cannot accept something the server
 * will reject. FR-AUTH-06: drivers must accept the consent notice.
 */
import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { Button, Checkbox, HelperText, SegmentedButtons, Text, TextInput, useTheme } from 'react-native-paper';
import { useTranslation } from 'react-i18next';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { RegisterRequestSchema } from '@crashlink/contracts';

import { useRegister } from '../../src/api/hooks/useAuth';
import { ApiError } from '../../src/api/client';
import { spacing } from '../../src/theme';

export default function Register() {
  const theme = useTheme();
  const { t } = useTranslation();
  const register = useRegister();

  const [role, setRole] = useState<'OWNER' | 'DRIVER'>('DRIVER');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const normalised = parsePhoneNumberFromString(phone, 'LK');
  const phoneValid = Boolean(normalised?.isValid());

  // FR-AUTH-06: consent is required for drivers before their first rental.
  const consentRequired = role === 'DRIVER';
  const canSubmit =
    name.trim().length >= 2 &&
    email.includes('@') &&
    phoneValid &&
    password.length >= 8 &&
    (!consentRequired || consent);

  const onSubmit = async (): Promise<void> => {
    setError(null);
    if (!normalised) return;

    const payload = {
      role,
      name: name.trim(),
      email: email.trim().toLowerCase(),
      phone: normalised.number,
      password,
      consentAccepted: consent,
    };

    // Validate against the shared contract before spending a round trip.
    const parsed = RegisterRequestSchema.safeParse(payload);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? t('common.error'));
      return;
    }

    try {
      await register.mutateAsync(parsed.data);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.code === 'EMAIL_TAKEN'
            ? 'That email is already registered.'
            : caught.code === 'PHONE_TAKEN'
              ? 'That phone number is already registered.'
              : caught.message
          : t('common.error'),
      );
    }
  };

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text variant="headlineMedium" style={styles.title}>
          {t('auth.register')}
        </Text>

        <Text variant="labelLarge">{t('auth.role')}</Text>
        <SegmentedButtons
          value={role}
          onValueChange={(value) => setRole(value as 'OWNER' | 'DRIVER')}
          buttons={[
            { value: 'DRIVER', label: t('auth.driver') },
            { value: 'OWNER', label: t('auth.owner') },
          ]}
        />

        <TextInput label={t('auth.name')} value={name} onChangeText={setName} mode="outlined" autoCapitalize="words" />

        <TextInput
          label={t('auth.email')}
          value={email}
          onChangeText={setEmail}
          mode="outlined"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
        />

        <TextInput
          label={t('auth.phone')}
          value={phone}
          onChangeText={setPhone}
          mode="outlined"
          keyboardType="phone-pad"
        />
        <HelperText type={phone.length === 0 || phoneValid ? 'info' : 'error'} visible>
          {phone.length === 0 ? '+94…' : phoneValid ? normalised!.number : 'Enter a valid phone number'}
        </HelperText>

        <TextInput
          label={t('auth.password')}
          value={password}
          onChangeText={setPassword}
          mode="outlined"
          secureTextEntry
          autoCapitalize="none"
        />
        <HelperText type={password.length === 0 || password.length >= 8 ? 'info' : 'error'} visible>
          At least 8 characters
        </HelperText>

        {consentRequired ? (
          <View style={styles.consentRow}>
            <Checkbox status={consent ? 'checked' : 'unchecked'} onPress={() => setConsent((v) => !v)} />
            <Text variant="bodySmall" style={styles.consentText} onPress={() => setConsent((v) => !v)}>
              {t('auth.consent')}
            </Text>
          </View>
        ) : null}

        {error ? (
          <Text variant="bodySmall" style={{ color: theme.colors.error }}>
            {error}
          </Text>
        ) : null}

        <Button
          mode="contained"
          onPress={() => void onSubmit()}
          loading={register.isPending}
          disabled={register.isPending || !canSubmit}
          contentStyle={styles.tall}
        >
          {t('auth.register')}
        </Button>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { padding: spacing(3), gap: spacing(1), flexGrow: 1 },
  title: { fontWeight: '700', marginBottom: spacing(1) },
  tall: { height: 52 },
  consentRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 4 },
  consentText: { flex: 1, paddingTop: 8 },
});
