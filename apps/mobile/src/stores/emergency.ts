/**
 * emergencyStore (§4.2, §2.4) - the pending safety question and the state of
 * the rider's answer.
 *
 * Three independent sources can raise the same question (§2.4): the Socket.IO
 * `incident.question` event, the 5 s poll of `GET /drivers/me/pending-question`,
 * and a notification tap. They converge here, keyed by incident id, so the
 * screen opens once no matter how many of them fire.
 */
import { create } from 'zustand';

export interface PendingQuestion {
  incidentId: string;
  label: string;
  occurredAt: string;
  questionSentAt: string;
  responseDeadlineAt: string;
}

/**
 * §2.4 status line. These map one-to-one onto what the rider is told, and no
 * state claims more than the server actually confirmed:
 *  - `sending`   "Sending…"
 *  - `accepted`  "Accepted by server · syncing to bike"
 *  - `synced`    "Synced with bike ✓"      (only on deviceSync === SYNCED)
 *  - `tooLate`   "Too late — emergency contact already notified at …"
 *  - `offline`   "Cannot reach server — retrying…"
 */
export type ResponseStatus = 'idle' | 'sending' | 'accepted' | 'synced' | 'tooLate' | 'offline';

export interface EmergencyState {
  question: PendingQuestion | null;
  /** Incidents already answered, so a late poll cannot reopen the screen. */
  resolved: Record<string, true>;
  status: ResponseStatus;
  /** The decision that won, when this rider's answer did not. */
  losingDecision: { decision: string; decidedAt: string | null } | null;
  choice: 'SAFE' | 'HELP' | null;
  /** Reused across retries so the server can dedupe (§2.4, §5.4.1). */
  idempotencyKey: string | null;

  open: (question: PendingQuestion) => void;
  setStatus: (status: ResponseStatus) => void;
  setChoice: (choice: 'SAFE' | 'HELP', idempotencyKey: string) => void;
  setLosingDecision: (decision: string, decidedAt: string | null) => void;
  resolve: (incidentId: string) => void;
  reset: () => void;
}

export const useEmergencyStore = create<EmergencyState>((set, get) => ({
  question: null,
  resolved: {},
  status: 'idle',
  losingDecision: null,
  choice: null,
  idempotencyKey: null,

  open: (question) => {
    const state = get();
    // Already answered, or already showing: do not restart the countdown.
    if (state.resolved[question.incidentId]) return;
    if (state.question?.incidentId === question.incidentId) return;

    set({
      question,
      status: 'idle',
      choice: null,
      idempotencyKey: null,
      losingDecision: null,
    });
  },

  setStatus: (status) => set({ status }),

  setChoice: (choice, idempotencyKey) => set({ choice, idempotencyKey }),

  setLosingDecision: (decision, decidedAt) =>
    set({ losingDecision: { decision, decidedAt }, status: 'tooLate' }),

  resolve: (incidentId) =>
    set((state) => ({
      resolved: { ...state.resolved, [incidentId]: true },
      question: state.question?.incidentId === incidentId ? null : state.question,
    })),

  reset: () =>
    set({ question: null, status: 'idle', choice: null, idempotencyKey: null, losingDecision: null }),
}));
