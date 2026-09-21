/**
 * NFR-04 honesty rules: FR-NOT-02 delivery wording, FR-MON-03 freshness,
 * FR-IMG-03 photo status. Pure functions plus a scan of every UI string.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NotificationStateSchema } from '@crashlink/contracts';
import {
  DELIVERED_STATES,
  freshness,
  freshnessText,
  isDelivered,
  notificationStateLabel,
  photoLine,
} from '../src/lib/honesty';

const DELIVER = /deliver/i;

describe('FR-NOT-02 notification wording', () => {
  it('only NETWORK_CONFIRMED and CLIENT_RECEIVED count as delivered', () => {
    expect([...DELIVERED_STATES].sort()).toEqual(['CLIENT_RECEIVED', 'NETWORK_CONFIRMED']);
    for (const state of NotificationStateSchema.options) {
      expect(isDelivered(state)).toBe(state === 'NETWORK_CONFIRMED' || state === 'CLIENT_RECEIVED');
    }
  });

  it('no other state has a label that mentions delivery', () => {
    for (const state of NotificationStateSchema.options) {
      expect(DELIVER.test(notificationStateLabel(state)), state).toBe(isDelivered(state));
    }
    expect(notificationStateLabel('AT_SUBMITTED')).toBe('Submitted to network');
  });

  it('no string in en.json claims delivery, except the two delivered states', () => {
    const en = JSON.parse(readFileSync(resolve(__dirname, '../src/i18n/en.json'), 'utf8')) as Record<
      string,
      Record<string, string>
    >;
    const allowed = new Set(['notification.networkConfirmed', 'notification.clientReceived']);
    const offenders: string[] = [];
    for (const [section, strings] of Object.entries(en)) {
      for (const [key, value] of Object.entries(strings)) {
        if (DELIVER.test(value) && !allowed.has(`${section}.${key}`)) offenders.push(`${section}.${key}: ${value}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('FR-MON-03 freshness', () => {
  it('is UNAVAILABLE with no fix', () => {
    expect(freshness(null)).toEqual({ kind: 'UNAVAILABLE' });
    expect(freshness({ kind: 'UNAVAILABLE', ageSec: null, source: null })).toEqual({ kind: 'UNAVAILABLE' });
  });

  it('says DEMO for simulator fixes, whatever their age', () => {
    expect(freshness({ kind: 'LIVE', ageSec: 2, source: 'DEMO' })).toEqual({ kind: 'DEMO' });
    expect(freshness({ kind: 'LAST_KNOWN', ageSec: 3600, source: 'DEMO' })).toEqual({ kind: 'DEMO' });
  });

  it('is LIVE only up to 30 s, then LAST KNOWN with minutes', () => {
    expect(freshness({ kind: 'LIVE', ageSec: 30, source: 'GPS' })).toEqual({ kind: 'LIVE' });
    // The server said LIVE, but the fix aged on the way here.
    expect(freshness({ kind: 'LIVE', ageSec: 31, source: 'GPS' })).toEqual({ kind: 'LAST_KNOWN', minutes: 1 });
    expect(freshness({ kind: 'LAST_KNOWN', ageSec: 660, source: 'GPS' })).toEqual({ kind: 'LAST_KNOWN', minutes: 11 });
  });

  it('marks an incident fix as at the event', () => {
    expect(freshnessText({ kind: 'LAST_KNOWN', ageSec: 120, source: 'GPS' }, true)).toBe(
      'Last known · 2 min at the event',
    );
  });
});

describe('FR-IMG-03 photo status', () => {
  it('reports real upload progress', () => {
    expect(photoLine({ status: 'UPLOADING', progress: 0.42 })).toEqual({
      key: 'incident.photoUploading',
      params: { percent: 42 },
      showImage: false,
    });
    expect(photoLine({ status: 'UPLOADING', progress: null }).params).toEqual({ percent: 0 });
  });

  it('shows the image only when available, not expired, and not restricted', () => {
    expect(photoLine({ status: 'AVAILABLE' }).showImage).toBe(true);
    expect(photoLine({ status: 'AVAILABLE', expired: true })).toMatchObject({
      key: 'incident.photoExpired',
      showImage: false,
    });
    expect(photoLine({ status: 'AVAILABLE' }, true)).toMatchObject({ key: 'incident.photoOwnerOnly', showImage: false });
    expect(photoLine({ status: 'FAILED' })).toMatchObject({ key: 'incident.photoFailed', showImage: false });
    expect(photoLine(null).key).toBe('incident.photoNotRequested');
  });
});
