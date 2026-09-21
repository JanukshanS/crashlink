/**
 * NotificationBridge (§4.2, §2.3.4).
 *
 * Turns a notification tap into navigation. §2.4 trigger 3 of 3: tapping an
 * `INCIDENT_QUESTION` opens the emergency screen.
 *
 * The payload is treated as untrusted routing input only - it names an incident
 * id, and the destination screen then loads that incident from the API. Nothing
 * is displayed from the notification itself (§2.3.4: "push is an attention aid
 * only; the app always re-fetches truth from the API").
 */
import React, { useEffect } from 'react';
import { useRouter } from 'expo-router';
import { Notifications, parseNotificationData, requestNotificationPermission } from '../notifications';
import { useAuthStore } from '../stores/auth';

export const NotificationBridge: React.FC<{ enabled: boolean }> = ({ enabled }) => {
  const router = useRouter();
  const role = useAuthStore((state) => state.user?.role);

  useEffect(() => {
    if (!enabled || !role) return;
    void requestNotificationPermission();
  }, [enabled, role]);

  useEffect(() => {
    if (!enabled || !role) return;

    const route = (data: unknown): void => {
      const tap = parseNotificationData(data);
      if (!tap) return;

      if (tap.type === 'INCIDENT_QUESTION' && role === 'DRIVER') {
        router.push(`/emergency/${tap.incidentId}` as never);
        return;
      }

      // Owners and admins land on the incident detail, where the truth lives.
      if (role === 'OWNER' || role === 'GUEST' || role === 'ADMIN') {
        router.push(`/(owner)/incidents/${tap.incidentId}` as never);
      }
    };

    if (!Notifications) return;

    // A tap that launched the app from cold start.
    void Notifications.getLastNotificationResponseAsync().then((response) => {
      if (response) route(response.notification.request.content.data);
    });

    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      route(response.notification.request.content.data);
    });

    return () => subscription.remove();
  }, [enabled, role, router]);

  return null;
};
