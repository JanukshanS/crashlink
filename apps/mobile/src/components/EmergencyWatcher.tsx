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
import { api } from '../api/client';
import type { IncidentDetailDto } from '@crashlink/contracts';

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
  const status = useEmergencyStore((state) => state.status);

  /**
   * The server has stopped asking about the open question - the bike's SAFE
   * button, an SOS, or a TIMEOUT decided it. Find out which, so the emergency
   * screen stops asking too. This lives here rather than on the screen so it
   * still runs while the screen is being opened or the app has just resumed.
   */
  useEffect(() => {
    if (!isDriver || !question) return;
    if (status !== 'idle' && status !== 'offline') return;
    const payload = pending.data;
    if (!payload) return;
    if (payload.question && payload.question.incidentId === question.incidentId && !payload.question.myResponse) return;

    let cancelled = false;
    void api
      .get<IncidentDetailDto>(`/incidents/${question.incidentId}`)
      .then((incident) => {
        if (cancelled) return;
        if (incident.decision && incident.decision !== 'PENDING' && incident.decision !== 'NOT_APPLICABLE') {
          useEmergencyStore.getState().setLosingDecision(incident.decision, incident.decidedAt ?? null);
        }
      })
      .catch(() => {
        // Offline: the screen's own poll and the socket remain as backstops.
      });
    return () => {
      cancelled = true;
    };
  }, [isDriver, question, status, pending.data]);

  useEffect(() => {
    if (!isDriver || !question) return;

    const target = `/emergency/${question.incidentId}`;
    if (pathname === target) return;

    router.push(target as never);
  }, [isDriver, question, pathname, router]);

  return null;
};
