/**
 * Material 3 theme (§4.2).
 *
 * The palette is built around the one colour that matters: emergency red is
 * reserved for EMERGENCY incidents and never used for ordinary destructive
 * actions, so a red screen always means the same thing.
 *
 * NFR-08: primary buttons are >= 72 dp and text is readable at arm's length.
 */
import { MD3DarkTheme, MD3LightTheme, type MD3Theme } from 'react-native-paper';

export const EMERGENCY_RED = '#B3261E';
export const SAFE_GREEN = '#1B7F3B';
export const SECURITY_AMBER = '#B26A00';
export const INFO_BLUE = '#2F5FA8';

/** §2.3.3 device-health colours: green OK, amber degraded, red offline. */
export const HEALTH_COLORS = {
  ok: SAFE_GREEN,
  degraded: SECURITY_AMBER,
  down: EMERGENCY_RED,
} as const;

/** §2.3.4 incident category colours. */
export const CATEGORY_COLORS = {
  EMERGENCY: EMERGENCY_RED,
  SECURITY: SECURITY_AMBER,
  INFO: INFO_BLUE,
} as const;

/** NFR-08: minimum touch target for the emergency buttons. */
export const EMERGENCY_BUTTON_HEIGHT = 84;
export const MIN_TOUCH_TARGET = 48;

export const lightTheme: MD3Theme = {
  ...MD3LightTheme,
  colors: {
    ...MD3LightTheme.colors,
    primary: '#1F5FA8',
    secondary: '#3F6B52',
    error: EMERGENCY_RED,
    background: '#FAFAFC',
  },
};

export const darkTheme: MD3Theme = {
  ...MD3DarkTheme,
  colors: {
    ...MD3DarkTheme.colors,
    primary: '#A6C8FF',
    secondary: '#A9D6BC',
    error: '#F2B8B5',
    background: '#121316',
  },
};

export const spacing = (units: number): number => units * 8;
