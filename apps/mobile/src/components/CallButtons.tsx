/**
 * CallButtons (§2.3.6 incident detail, §2.4 emergency screen).
 *
 * Opens the dialler with `tel:` - it never places a call by itself. On an
 * emergency screen a surprise outbound call would be worse than a tap.
 *
 * Sri Lanka: 1990 Suwa Seriya ambulance, 119 police.
 */
import React from 'react';
import { Alert, Linking, StyleSheet, View } from 'react-native';
import { Button } from 'react-native-paper';
import { useTranslation } from 'react-i18next';
import { EMERGENCY_RED, MIN_TOUCH_TARGET } from '../theme';

export const AMBULANCE_NUMBER = '1990';
export const POLICE_NUMBER = '119';

export const dial = async (phone: string): Promise<void> => {
  const url = `tel:${phone.replace(/\s/g, '')}`;
  try {
    const supported = await Linking.canOpenURL(url);
    if (!supported) {
      Alert.alert('Cannot open dialler', `Dial ${phone} manually.`);
      return;
    }
    await Linking.openURL(url);
  } catch {
    Alert.alert('Cannot open dialler', `Dial ${phone} manually.`);
  }
};

export interface CallTarget {
  label: string;
  phone: string | null | undefined;
  emphasis?: boolean;
}

export interface CallButtonsProps {
  /** Contacts specific to the context: rider, emergency contact, owner. */
  targets?: CallTarget[];
  /** Show the national emergency numbers (default true). */
  showEmergencyServices?: boolean;
  compact?: boolean;
}

export const CallButtons: React.FC<CallButtonsProps> = ({
  targets = [],
  showEmergencyServices = true,
  compact = false,
}) => {
  const { t } = useTranslation();

  // A masked number cannot be dialled, so the button is not offered: a driver
  // viewing their own rental sees "+94•••••4567", which is not a phone number.
  const callable = targets.filter(
    (target) => target.phone && !target.phone.includes('•') && /\d{5,}/.test(target.phone),
  );

  return (
    <View style={styles.container}>
      {callable.map((target) => (
        <Button
          key={`${target.label}-${target.phone}`}
          mode={target.emphasis ? 'contained' : 'outlined'}
          icon="phone"
          onPress={() => void dial(target.phone!)}
          style={styles.button}
          contentStyle={compact ? undefined : styles.content}
        >
          {target.label}
        </Button>
      ))}

      {showEmergencyServices ? (
        <>
          <Button
            mode="contained"
            icon="ambulance"
            buttonColor={EMERGENCY_RED}
            textColor="#FFFFFF"
            onPress={() => void dial(AMBULANCE_NUMBER)}
            style={styles.button}
            contentStyle={compact ? undefined : styles.content}
          >
            {t('emergency.call1990')}
          </Button>
          <Button
            mode="outlined"
            icon="police-badge"
            onPress={() => void dial(POLICE_NUMBER)}
            style={styles.button}
            contentStyle={compact ? undefined : styles.content}
          >
            {t('emergency.call119')}
          </Button>
        </>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  container: { gap: 8 },
  button: { borderRadius: 8 },
  content: { minHeight: MIN_TOUCH_TARGET },
});
