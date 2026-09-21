/**
 * NotificationStateChip (FR-NOT-02, NFR-04).
 *
 * The single rule this file exists to enforce: **never show "Delivered" unless
 * the state is NETWORK_CONFIRMED (a real +CDS delivery report from the network)
 * or CLIENT_RECEIVED (the app acknowledged it).**
 *
 * `AT_SUBMITTED` means the modem accepted the message. It does not mean anyone
 * received it, and an owner who reads "delivered" there may stop looking for
 * their rider.
 */
import React from 'react';
import { StyleSheet } from 'react-native';
import { Chip } from 'react-native-paper';
import type { NotificationState } from '@crashlink/contracts';
import { notificationStateLabel } from '../lib/honesty';
import { EMERGENCY_RED, INFO_BLUE, SAFE_GREEN, SECURITY_AMBER } from '../theme';

export { DELIVERED_STATES, isDelivered, notificationStateLabel } from '../lib/honesty';

const COLORS: Record<NotificationState, string> = {
  REQUESTED: '#8A8A8E',
  QUEUED: '#8A8A8E',
  AT_SUBMITTED: SECURITY_AMBER,
  NETWORK_CONFIRMED: SAFE_GREEN,
  PROVIDER_ACCEPTED: SECURITY_AMBER,
  CLIENT_RECEIVED: SAFE_GREEN,
  RESPONDED: SAFE_GREEN,
  FAILED: EMERGENCY_RED,
  OUTCOME_UNKNOWN: INFO_BLUE,
};

export interface NotificationStateChipProps {
  state: NotificationState;
  compact?: boolean;
}

export const NotificationStateChip: React.FC<NotificationStateChipProps> = ({ state, compact }) => (
  <Chip compact={compact} style={[styles.chip, { backgroundColor: COLORS[state] }]} textStyle={styles.text}>
    {notificationStateLabel(state)}
  </Chip>
);

const styles = StyleSheet.create({
  chip: { alignSelf: 'flex-start' },
  text: { fontSize: 11, fontWeight: '600', color: '#FFFFFF' },
});
