/**
 * The app's honesty rules (NFR-04), as pure functions so they are unit-tested
 * rather than trusted to each screen:
 *
 *  - FR-NOT-02: nothing says "delivered" unless the state is NETWORK_CONFIRMED
 *    (a real network delivery report) or CLIENT_RECEIVED (the app acked).
 *  - FR-MON-03: every location carries LIVE / LAST KNOWN · n min / UNAVAILABLE
 *    / DEMO, and DEMO wins over age so simulator output never passes as real.
 *  - FR-IMG-03: the photo line says what is true, including "deleted after the
 *    retention period" and "visible to the bike owner only".
 *
 * No React or React Native imports here, on purpose.
 */
import type { NotificationState, PhotoStatus } from '@crashlink/contracts';

// ---------------------------------------------------------------------------
// FR-NOT-02 notification states
// ---------------------------------------------------------------------------

/** The only two states that may be described as delivered. */
export const DELIVERED_STATES: readonly NotificationState[] = ['NETWORK_CONFIRMED', 'CLIENT_RECEIVED'];

export const isDelivered = (state: NotificationState): boolean => DELIVERED_STATES.includes(state);

/**
 * Deliberately verbose: "Submitted to network" is longer than "Delivered" and
 * that is the point - it is all the modem actually reported.
 */
const NOTIFICATION_LABELS: Record<NotificationState, string> = {
  REQUESTED: 'Requested',
  QUEUED: 'Queued on the bike',
  AT_SUBMITTED: 'Submitted to network',
  NETWORK_CONFIRMED: 'Delivered',
  PROVIDER_ACCEPTED: 'Accepted by provider',
  CLIENT_RECEIVED: 'Delivered to app',
  RESPONDED: 'Answered',
  FAILED: 'Failed',
  OUTCOME_UNKNOWN: 'Outcome unknown',
};

export const notificationStateLabel = (state: NotificationState): string => NOTIFICATION_LABELS[state] ?? state;

// ---------------------------------------------------------------------------
// FR-MON-03 location freshness
// ---------------------------------------------------------------------------

/** §2.3.3: a fix counts as LIVE for 30 s. */
export const LIVE_MAX_AGE_SEC = 30;

export type Freshness =
  | { kind: 'UNAVAILABLE' }
  | { kind: 'DEMO' }
  | { kind: 'LIVE' }
  | { kind: 'LAST_KNOWN'; minutes: number };

export interface FreshnessInput {
  kind: 'LIVE' | 'LAST_KNOWN' | 'UNAVAILABLE';
  ageSec: number | null;
  source: 'GPS' | 'DEMO' | null;
}

export const freshness = (location: FreshnessInput | null | undefined): Freshness => {
  if (!location || location.kind === 'UNAVAILABLE') return { kind: 'UNAVAILABLE' };
  if (location.source === 'DEMO') return { kind: 'DEMO' };

  const ageSec = location.ageSec ?? 0;
  if (location.kind === 'LIVE' && ageSec <= LIVE_MAX_AGE_SEC) return { kind: 'LIVE' };

  // Anything older is last-known - including a fix the server still called
  // LIVE that aged on the way to this screen.
  return { kind: 'LAST_KNOWN', minutes: Math.max(1, Math.round(ageSec / 60)) };
};

/** Plain-text freshness for places a badge cannot go, e.g. a map popup. */
export const freshnessText = (location: FreshnessInput | null | undefined, atEvent = false): string => {
  const value = freshness(location);
  const suffix = atEvent ? ' at the event' : '';
  switch (value.kind) {
    case 'UNAVAILABLE':
      return 'Location unavailable';
    case 'DEMO':
      return 'DEMO location';
    case 'LIVE':
      return `Live fix${suffix}`;
    case 'LAST_KNOWN':
      return `Last known · ${value.minutes} min${suffix}`;
  }
};

// ---------------------------------------------------------------------------
// FR-IMG-03 photo status
// ---------------------------------------------------------------------------

export interface PhotoInput {
  status: PhotoStatus;
  progress?: number | null;
  expired?: boolean;
}

/** An i18n key plus its params, so the component stays the only place that renders text. */
export interface PhotoLine {
  key:
    | 'incident.photoNotRequested'
    | 'incident.photoPending'
    | 'incident.photoUploading'
    | 'incident.photoAvailable'
    | 'incident.photoFailed'
    | 'incident.photoExpired'
    | 'incident.photoOwnerOnly';
  params?: { percent: number };
  /** Whether the image itself may be requested and shown. */
  showImage: boolean;
}

/**
 * @param restricted true for the read-only judge: §5.7.2 Images, GUEST ✗
 *   (placeholder). They learn a photo exists, not what it shows.
 */
export const photoLine = (photo: PhotoInput | null | undefined, restricted = false): PhotoLine => {
  if (!photo) return { key: 'incident.photoNotRequested', showImage: false };

  if (photo.status === 'AVAILABLE') {
    if (photo.expired) return { key: 'incident.photoExpired', showImage: false };
    if (restricted) return { key: 'incident.photoOwnerOnly', showImage: false };
    return { key: 'incident.photoAvailable', showImage: true };
  }
  if (photo.status === 'UPLOADING') {
    const percent =
      typeof photo.progress === 'number' ? Math.max(0, Math.min(100, Math.round(photo.progress * 100))) : 0;
    return { key: 'incident.photoUploading', params: { percent }, showImage: false };
  }
  if (photo.status === 'PENDING') return { key: 'incident.photoPending', showImage: false };
  // An unverified photo is evidence of nothing, so it is never shown.
  if (photo.status === 'FAILED') return { key: 'incident.photoFailed', showImage: false };
  return { key: 'incident.photoNotRequested', showImage: false };
};
