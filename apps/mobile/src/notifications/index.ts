/**
 * Notifications (§2.3.4, §4.2).
 *
 * Android channels: `emergency` (MAX, alarm sound, vibration), `security`
 * (HIGH), `info` (DEFAULT).
 *
 * A push is an **attention aid only** - the app always re-fetches the truth
 * from the API after a tap (§2.3.4). Nothing in the app acts on a notification
 * payload alone, because a stale or spoofed one must not be able to tell a
 * rider they are in an incident.
 *
 * FCM is out of scope for the MVP (M7), so these are local notifications
 * raised from socket events while the app is running. The channel setup and
 * tap handling are the same either way, so adding FCM later is a token
 * registration, not a rewrite.
 */
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import type { IncidentCategory } from '@crashlink/contracts';

export const CHANNELS = {
  emergency: 'emergency',
  security: 'security',
  info: 'info',
} as const;

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/** §2.3.4: three channels with distinct importance, created once at startup. */
export const registerNotificationChannels = async (): Promise<void> => {
  if (Platform.OS !== 'android') return;

  await Notifications.setNotificationChannelAsync(CHANNELS.emergency, {
    name: 'Emergency alerts',
    importance: Notifications.AndroidImportance.MAX,
    // A crash alert must be able to wake a phone left on a table.
    sound: 'alarm.wav',
    vibrationPattern: [0, 500, 250, 500, 250, 500],
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    bypassDnd: true,
    enableVibrate: true,
    lightColor: '#B3261E',
  });

  await Notifications.setNotificationChannelAsync(CHANNELS.security, {
    name: 'Security alerts',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 300, 200, 300],
    enableVibrate: true,
  });

  await Notifications.setNotificationChannelAsync(CHANNELS.info, {
    name: 'Ride events',
    importance: Notifications.AndroidImportance.DEFAULT,
    enableVibrate: false,
  });
};

export type PermissionState = 'granted' | 'denied' | 'undetermined';

/** §2.3.4: a denial is surfaced as a warning card, never silently swallowed. */
export const requestNotificationPermission = async (): Promise<PermissionState> => {
  if (!Device.isDevice) return 'undetermined';

  const existing = await Notifications.getPermissionsAsync();
  if (existing.granted) return 'granted';
  if (!existing.canAskAgain) return 'denied';

  const requested = await Notifications.requestPermissionsAsync();
  return requested.granted ? 'granted' : 'denied';
};

const channelFor = (category: IncidentCategory): string => {
  switch (category) {
    case 'EMERGENCY':
      return CHANNELS.emergency;
    case 'SECURITY':
      return CHANNELS.security;
    default:
      return CHANNELS.info;
  }
};

export interface IncidentNotificationInput {
  incidentId: string;
  title: string;
  body: string;
  category: IncidentCategory;
  /** Set for the driver's safety question, which routes to the emergency screen. */
  isQuestion?: boolean;
}

export const showLocalIncidentNotification = async (
  input: IncidentNotificationInput,
): Promise<void> => {
  await Notifications.scheduleNotificationAsync({
    content: {
      title: input.title,
      body: input.body,
      // §5.5 FCM payload shape, kept identical so the tap handler is shared.
      data: {
        type: input.isQuestion ? 'INCIDENT_QUESTION' : 'INCIDENT_CREATED',
        incidentId: input.incidentId,
      },
      ...(Platform.OS === 'android'
        ? { channelId: input.isQuestion ? CHANNELS.emergency : channelFor(input.category) }
        : {}),
    },
    trigger: null,
  });
};

/** Used by the settings screen's "test notification" button (§2.3.7). */
export const sendTestNotification = async (): Promise<void> => {
  await Notifications.scheduleNotificationAsync({
    content: {
      title: 'CrashLink test',
      body: 'Notifications are working. Emergency alerts use a louder channel.',
      ...(Platform.OS === 'android' ? { channelId: CHANNELS.info } : {}),
    },
    trigger: null,
  });
};

export interface NotificationTap {
  type: 'INCIDENT_QUESTION' | 'INCIDENT_CREATED' | 'SECURITY_ALERT';
  incidentId: string;
}

/** Reads a tap payload defensively - it arrives from outside the app. */
export const parseNotificationData = (data: unknown): NotificationTap | null => {
  if (!data || typeof data !== 'object') return null;

  const record = data as Record<string, unknown>;
  const incidentId = typeof record['incidentId'] === 'string' ? record['incidentId'] : null;
  const type = typeof record['type'] === 'string' ? record['type'] : null;

  if (!incidentId || !type) return null;
  if (type !== 'INCIDENT_QUESTION' && type !== 'INCIDENT_CREATED' && type !== 'SECURITY_ALERT') {
    return null;
  }

  return { type, incidentId };
};

export { Notifications };
