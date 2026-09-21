/**
 * Expo config (§4.2, §5.8.3).
 *
 * `EXPO_PUBLIC_API_URL` is baked in at build time - the APK is handed to judges
 * on a phone with no dev server, so there is nowhere to configure it later.
 */
import type { ExpoConfig, ConfigContext } from 'expo/config';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://10.0.2.2:3000';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'CrashLink',
  slug: 'crashlink',
  version: '1.0.0',
  orientation: 'portrait',
  scheme: 'crashlink',
  userInterfaceStyle: 'automatic',

  android: {
    package: 'lk.iotrix.crashlink',
    versionCode: 1,
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      backgroundColor: '#B3261E',
    },
    permissions: [
      'INTERNET',
      'ACCESS_NETWORK_STATE',
      'VIBRATE',
      'POST_NOTIFICATIONS',
      // The emergency screen must be able to wake and stay lit.
      'WAKE_LOCK',
      // CallButtons use `tel:` - dialling, never placing the call for the user.
      'CALL_PHONE',
    ],
    // §2.3.2 nice-to-have: QR pairing deep link.
    intentFilters: [
      {
        action: 'VIEW',
        data: [{ scheme: 'crashlink', host: 'pair' }],
        category: ['BROWSABLE', 'DEFAULT'],
      },
    ],
  },

  ios: {
    bundleIdentifier: 'lk.iotrix.crashlink',
    supportsTablet: false,
  },

  plugins: [
    'expo-router',
    'expo-secure-store',
    [
      'expo-notifications',
      {
        // §2.3.4: the alarm sound is bundled so the emergency channel can use
        // it even when the phone is on vibrate.
        sounds: ['./assets/alarm.wav'],
      },
    ],
    [
      'expo-build-properties',
      {
        android: {
          // Plain HTTP to the device gateway host during the demo (§5.3.1);
          // the app itself talks HTTPS in production.
          usesCleartextTraffic: true,
        },
      },
    ],
  ],

  extra: {
    apiUrl: API_URL,
    router: {},
    eas: { projectId: undefined },
  },

  experiments: {
    typedRoutes: true,
  },
});
