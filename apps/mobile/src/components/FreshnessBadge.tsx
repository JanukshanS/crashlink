/**
 * FreshnessBadge (§2.3.3, FR-MON-03).
 *
 * Every location in this app renders one of these. A dot on a map with no
 * freshness label is a claim that the bike is there *now*, and for a last-known
 * fix from eleven minutes ago that claim is false.
 *
 *   LIVE            fix <= 30 s old
 *   LAST KNOWN · n min
 *   UNAVAILABLE     no fix at all
 *   DEMO            simulator-sourced, always labelled as such
 *
 * The rules live in src/lib/honesty.ts and are unit-tested there.
 */
import React from 'react';
import { StyleSheet, type TextStyle } from 'react-native';
import { Chip } from 'react-native-paper';
import { useTranslation } from 'react-i18next';
import type { LocationDto } from '@crashlink/contracts';
import { freshness } from '../lib/honesty';
import { INFO_BLUE, SAFE_GREEN, SECURITY_AMBER } from '../theme';

export { LIVE_MAX_AGE_SEC } from '../lib/honesty';

export interface FreshnessBadgeProps {
  location: Pick<LocationDto, 'kind' | 'ageSec' | 'source'> | null | undefined;
  compact?: boolean;
  /**
   * The fix belongs to an incident, not the bike's current position. Age is
   * then measured from the event, and the badge says so.
   */
  atEvent?: boolean;
}

export const FreshnessBadge: React.FC<FreshnessBadgeProps> = ({ location, compact, atEvent }) => {
  const { t } = useTranslation();
  const value = freshness(location);
  const suffix = atEvent ? ` · ${t('freshness.atEvent')}` : '';

  let label: string;
  let background: string;
  let textStyle: TextStyle = styles.textLight;
  switch (value.kind) {
    case 'UNAVAILABLE':
      label = t('freshness.unavailable');
      background = '#E0E0E4';
      textStyle = styles.text;
      break;
    case 'DEMO':
      label = t('freshness.demo');
      background = INFO_BLUE;
      break;
    case 'LIVE':
      label = t('freshness.live');
      background = SAFE_GREEN;
      break;
    case 'LAST_KNOWN':
      label = t('freshness.lastKnown', { minutes: value.minutes });
      background = SECURITY_AMBER;
      break;
  }

  return (
    <Chip compact={compact} style={[styles.chip, { backgroundColor: background }]} textStyle={textStyle}>
      {value.kind === 'UNAVAILABLE' ? label : `${label}${suffix}`}
    </Chip>
  );
};

const styles = StyleSheet.create({
  chip: { alignSelf: 'flex-start' },
  text: { fontSize: 11, fontWeight: '700', letterSpacing: 0.4 },
  textLight: { fontSize: 11, fontWeight: '700', letterSpacing: 0.4, color: '#FFFFFF' },
});
