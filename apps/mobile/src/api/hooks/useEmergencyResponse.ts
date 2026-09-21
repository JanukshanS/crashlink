/**
 * The rider's answer to "Are you safe?" (§2.4, §5.4.3).
 *
 * This is the most safety-critical call in the app, so it is deliberately
 * stubborn and deliberately honest:
 *
 *  - **Idempotency.** Each tap mints one UUID and every retry reuses it, so a
 *    flaky GPRS link cannot turn one "I'm safe" into two responses, and a
 *    retry after the server already accepted returns the original result.
 *  - **Retry only on network failure.** A 409 TOO_LATE is a real answer, not a
 *    transient error; retrying it would be pointless and would delay telling
 *    the rider the truth.
 *  - **No optimistic success.** The screen shows "Sending…" until the server
 *    replies, then "Accepted by server · syncing to bike", and only claims
 *    "Synced with bike" when `deviceSync === 'SYNCED'`.
 */
import { useCallback, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import * as Crypto from 'expo-crypto';
import { api, ApiError } from '../client';
import { queryKeys } from '../queryKeys';
import { useEmergencyStore } from '../../stores/emergency';

export interface ResponseResult {
  accepted: boolean;
  decision: string;
  serverAcceptedAt: string;
  deviceSync: 'PENDING' | 'SYNCED';
}

/** Max attempts for a request that never reached the server. */
const MAX_NETWORK_ATTEMPTS = 4;
const RETRY_DELAY_MS = 1500;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const newIdempotencyKey = (): string => Crypto.randomUUID();

export const useEmergencyResponse = (incidentId: string | undefined) => {
  const queryClient = useQueryClient();
  const store = useEmergencyStore();
  const inFlight = useRef(false);

  const respond = useCallback(
    async (choice: 'SAFE' | 'HELP'): Promise<ResponseResult | null> => {
      if (!incidentId || inFlight.current) return null;
      inFlight.current = true;

      const state = useEmergencyStore.getState();

      // Reuse the key across retries of the *same* tap; mint a new one when the
      // rider changes their answer (SAFE then HELP is a different statement).
      const key =
        state.idempotencyKey && state.choice === choice ? state.idempotencyKey : newIdempotencyKey();

      store.setChoice(choice, key);
      store.setStatus('sending');

      try {
        for (let attempt = 1; attempt <= MAX_NETWORK_ATTEMPTS; attempt += 1) {
          try {
            const result = await api.post<ResponseResult>(`/incidents/${incidentId}/responses`, {
              choice,
              idempotencyKey: key,
            });

            store.setStatus(result.deviceSync === 'SYNCED' ? 'synced' : 'accepted');

            void queryClient.invalidateQueries({ queryKey: queryKeys.pendingQuestion() });
            void queryClient.invalidateQueries({ queryKey: queryKeys.incident(incidentId) });

            return result;
          } catch (error) {
            if (error instanceof ApiError && error.isNetworkError) {
              // §2.4: "Cannot reach server — retrying…". The rider is told, and
              // reminded that the bike's own button still works.
              store.setStatus('offline');
              if (attempt < MAX_NETWORK_ATTEMPTS) {
                await delay(RETRY_DELAY_MS * attempt);
                continue;
              }
              return null;
            }

            if (error instanceof ApiError && error.code === 'TOO_LATE') {
              // D7: somebody else already decided. Show what won and when.
              const details = error.details as { decision?: string; decidedAt?: string | null };
              store.setLosingDecision(details.decision ?? 'TIMEOUT', details.decidedAt ?? null);
              void queryClient.invalidateQueries({ queryKey: queryKeys.incident(incidentId) });
              return null;
            }

            // Anything else is a real error; stop and let the screen say so.
            store.setStatus('offline');
            return null;
          }
        }

        return null;
      } finally {
        inFlight.current = false;
      }
    },
    [incidentId, queryClient, store],
  );

  /**
   * §2.4: posted when the screen opens, so the DRIVER_PROMPT notification can
   * honestly move to CLIENT_RECEIVED (FR-NOT-02).
   */
  const acknowledgeQuestion = useCallback(async (): Promise<void> => {
    if (!incidentId) return;
    // Best effort - failing to ack must never block the rider from answering.
    await api.post(`/incidents/${incidentId}/question-ack`, {}).catch(() => undefined);
  }, [incidentId]);

  return { respond, acknowledgeQuestion, status: store.status };
};
