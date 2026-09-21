/** Login (§2.3.1, FR-AUTH-02): email or phone + password. */
import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { Button, Text, TextInput, useTheme } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { useLogin } from '../../src/api/hooks/useAuth';
import { ApiError } from '../../src/api/client';
import { spacing } from '../../src/theme';

export default function Login() {
  const router = useRouter();
  const theme = useTheme();
  const { t } = useTranslation();
  const login = useLogin();

  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [secure, setSecure] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (): Promise<void> => {
    setError(null);
    try {
      await login.mutateAsync({ identifier: identifier.trim(), password });
      // AuthGate routes by role once the session lands.
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.isNetworkError
            ? 'Cannot reach the server. Check the API URL and your connection.'
            : caught.message
          : t('common.error'),
      );
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.container}>
        <Text variant="headlineMedium" style={styles.title}>
          {t('auth.login')}
        </Text>

        <TextInput
          label={t('auth.identifier')}
          value={identifier}
          onChangeText={setIdentifier}
          mode="outlined"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          autoComplete="username"
        />

        <TextInput
          label={t('auth.password')}
          value={password}
          onChangeText={setPassword}
          mode="outlined"
          secureTextEntry={secure}
          autoCapitalize="none"
          autoComplete="password"
          right={<TextInput.Icon icon={secure ? 'eye' : 'eye-off'} onPress={() => setSecure((v) => !v)} />}
        />

        {error ? (
          <Text variant="bodySmall" style={{ color: theme.colors.error }}>
            {error}
          </Text>
        ) : null}

        <Button
          mode="contained"
          onPress={() => void onSubmit()}
          loading={login.isPending}
          disabled={login.isPending || identifier.length < 3 || password.length < 1}
          contentStyle={styles.tall}
        >
          {t('auth.login')}
        </Button>

        <Button mode="text" onPress={() => router.push('/(auth)/register')}>
          {t('auth.register')}
        </Button>

        {/* M11: no password reset in this build - say so rather than offer it. */}
        <Text variant="bodySmall" style={styles.note}>
          {t('auth.noReset')}
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { padding: spacing(3), gap: spacing(1.5), flexGrow: 1, justifyContent: 'center' },
  title: { fontWeight: '700', marginBottom: spacing(1) },
  tall: { height: 52 },
  note: { opacity: 0.7, textAlign: 'center', marginTop: spacing(2) },
});
