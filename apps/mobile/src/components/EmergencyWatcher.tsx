/**
 * EmergencyWatcher (§4.2, §2.4).
 *
 * Runs the 5 s `GET /drivers/me/pending-question` poll while a rental is
 * active (trigger 2 of 3) and navigates to the emergency screen whenever a
 * question appears in the store - whoever put it there.
 *
 * Polling exists because the socket is the thing most likely to be missing
 * when it matters: the rider is on a moving bike on a 2G link. Sixty seconds
 * is not long enough to wait for a reconnect.
 */
import React, { useEffect } from 'react';
import { usePathname, useRouter } from 'expo-router';
import { useAuthStore } from '../stores/auth';
import { useEmergencyStore } from '../stores/emergency';
import { useRealtimeStore } from '../stores/realtime';
import { useActiveRental, usePendingQuestion } from '../api/hooks/useIncidents';

export const EmergencyWatcher: React.FC = () => {
  const router = useRouter();
  const pathname = usePathname();
  const role = useAuthStore((state) => state.user?.role);
  const isDriver = role === 'DRIVER';

  const activeRental = useActiveRental();
  const hasActiveRental = Boolean(activeRental.data?.rental);

  // §2.4 / FR-NOT-05: poll only while a rental is active. A rider with no bike
  // cannot have a pending question, and polling anyway wastes their data.
  const pending = usePendingQuestion(isDriver && hasActiveRental);

  useEffect(() => {
    if (!isDriver) return;
    const payload = pending.data;
    if (!payload) return;

    // Every poll carries the server clock, keeping the countdown honest.
    useRealtimeStore.getState().syncClock(payload.serverTime, Date.now());

    if (!payload.question) return;
    // Already answered on this device - do not reopen.
    if (payload.question.myResponse) return;

    useEmergencyStore.getState().open({
      incidentId: payload.question.incidentId,
      label: payload.question.label,
      occurredAt: payload.question.occurredAt,
      questionSentAt: payload.question.questionSentAt,
      responseDeadlineAt: payload.question.responseDeadlineAt,
    });
  }, [isDriver, pending.data]);

  const question = useEmergencyStore((state) => state.question);

  useEffect(() => {
    if (!isDriver || !question) return;

    const target = `/emergency/${question.incidentId}`;
    if (pathname === target) return;

    router.push(target as never);
  }, [isDriver, question, pathname, router]);

  return null;
};
