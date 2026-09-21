/**
 * IncidentTimeline, PhotoPanel and DeviceHealthCard (§2.3.6, §4.2).
 *
 * The timeline and photo panel are where honesty is easiest to lose: both are
 * places a UI is tempted to round "submitted" up to "delivered", or to show a
 * photo it has not verified. Neither happens here.
 */
import React from 'react';
import { Image, StyleSheet, View } from 'react-native';
import { ActivityIndicator, Card, Chip, Divider, Text, useTheme } from 'react-native-paper';
import { useTranslation } from 'react-i18next';
import type { DeviceHealthDto, PhotoStatus } from '@crashlink/contracts';
import { HEALTH_COLORS, SAFE_GREEN, SECURITY_AMBER, spacing } from '../theme';
import { photoLine } from '../lib/honesty';

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

export interface TimelineEntry {
  at: string;
  event: string;
  text: string;
}

const formatTime = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : // §CLAUDE.md: stored UTC, displayed Asia/Colombo.
      date.toLocaleString('en-GB', {
        timeZone: 'Asia/Colombo',
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
};

export const IncidentTimeline: React.FC<{ entries: TimelineEntry[] }> = ({ entries }) => {
  const theme = useTheme();

  if (entries.length === 0) {
    return <Text variant="bodySmall">No timeline entries yet</Text>;
  }

  return (
    <View style={styles.timeline}>
      {entries.map((entry, index) => (
        <View key={`${entry.at}-${entry.event}-${index}`} style={styles.timelineRow}>
          <View style={styles.timelineGutter}>
            <View style={[styles.timelineDot, { backgroundColor: theme.colors.primary }]} />
            {index < entries.length - 1 ? (
              <View style={[styles.timelineLine, { backgroundColor: theme.colors.outlineVariant }]} />
            ) : null}
          </View>
          <View style={styles.timelineBody}>
            {/* The text comes from the server, which words it honestly. */}
            <Text variant="bodyMedium">{entry.text}</Text>
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
              {formatTime(entry.at)}
            </Text>
          </View>
        </View>
      ))}
    </View>
  );
};

// ---------------------------------------------------------------------------
// Photo panel
// ---------------------------------------------------------------------------

export interface PhotoPanelProps {
  status: PhotoStatus;
  integrity?: 'VERIFIED' | 'UNVERIFIED' | 'MISMATCH' | null;
  imageUrl?: string | null;
  bytes?: number | null;
  /** 0..1 upload progress, as the server counted chunks. */
  progress?: number | null;
  /** Deleted by the retention worker. */
  expired?: boolean;
  /** §5.7.2: the judge sees that a photo exists, not the photo. */
  restricted?: boolean;
}

/** FR-IMG-03: NOT_REQUESTED / PENDING / UPLOADING n% / AVAILABLE / FAILED / expired. */
export const PhotoPanel: React.FC<PhotoPanelProps> = ({
  status,
  integrity,
  imageUrl,
  bytes,
  progress,
  expired,
  restricted,
}) => {
  const { t } = useTranslation();
  const theme = useTheme();
  const line = photoLine({ status, progress, expired }, restricted);

  return (
    <Card mode="outlined">
      <Card.Title title={t('incident.photo')} />
      <Card.Content style={styles.photoContent}>
        {line.showImage && imageUrl ? (
          <>
            <Image source={{ uri: imageUrl }} style={styles.photo} resizeMode="cover" />
            <View style={styles.row}>
              {/* §5.6.5: only claim "verified" when the hash actually matched. */}
              <Chip
                compact
                icon={integrity === 'VERIFIED' ? 'shield-check' : 'shield-alert'}
                style={{
                  backgroundColor: integrity === 'VERIFIED' ? SAFE_GREEN : SECURITY_AMBER,
                }}
                textStyle={styles.chipText}
              >
                {integrity === 'VERIFIED'
                  ? t('incident.integrityVerified')
                  : integrity === 'MISMATCH'
                    ? t('incident.integrityMismatch')
                    : t('incident.integrityUnverified')}
              </Chip>
              {bytes ? <Text variant="bodySmall">{(bytes / 1024).toFixed(1)} KB</Text> : null}
            </View>
          </>
        ) : line.key === 'incident.photoUploading' || line.key === 'incident.photoPending' ? (
          <View style={styles.row}>
            <ActivityIndicator size="small" />
            <Text variant="bodyMedium">{t(line.key, line.params)}</Text>
          </View>
        ) : line.key === 'incident.photoFailed' ? (
          // An unverified photo is not shown at all - it is evidence of nothing.
          <Text variant="bodyMedium" style={{ color: theme.colors.error }}>
            {t(line.key)}
          </Text>
        ) : (
          <Text variant="bodyMedium">{t(line.key)}</Text>
        )}
      </Card.Content>
    </Card>
  );
};

// ---------------------------------------------------------------------------
// Device health
// ---------------------------------------------------------------------------

export interface DeviceHealthCardProps {
  health: DeviceHealthDto | null;
  online: string;
  lastSeenAt: string | null;
  configVersion?: number;
  configPending?: boolean;
}

/** §2.3.3 colour rules: green all OK, amber degraded, red offline. */
const healthColor = (health: DeviceHealthDto | null, online: string): string => {
  if (online === 'OFFLINE' || !health) return HEALTH_COLORS.down;
  const degraded = !health.gpsFix || (health.csq !== null && health.csq < 10) || !health.cameraLink;
  return degraded ? HEALTH_COLORS.degraded : HEALTH_COLORS.ok;
};

export const DeviceHealthCard: React.FC<DeviceHealthCardProps> = ({
  health,
  online,
  lastSeenAt,
  configVersion,
  configPending,
}) => {
  const { t } = useTranslation();
  const color = healthColor(health, online);

  const rows: { label: string; value: string }[] = [
    { label: 'Online', value: online },
    { label: 'Last seen', value: lastSeenAt ? formatTime(lastSeenAt) : '—' },
    { label: 'Firmware', value: health?.fw ?? '—' },
    { label: 'Signal', value: health?.signalBars !== null && health?.signalBars !== undefined ? `${health.signalBars}/5 bars (CSQ ${health.csq ?? '—'})` : '—' },
    { label: 'GPRS', value: health?.gprs ? 'attached' : 'not attached' },
    {
      label: 'GPS',
      value: health?.gpsFix ? `fix · ${health.sats ?? '?'} sats · HDOP ${health.hdop ?? '?'}` : 'no fix',
    },
    { label: 'Camera link', value: health?.cameraLink ? 'up' : 'down' },
    // M10: battery is never measured, and the UI says exactly that.
    { label: 'Battery', value: t('common.notMeasured') },
    { label: 'Queued jobs', value: String(health?.queuedJobs ?? '—') },
  ];

  if (configVersion !== undefined) {
    rows.push({
      label: 'Config',
      value: `v${configVersion}${configPending ? ' · pending sync' : ' · applied'}`,
    });
  }

  return (
    <Card mode="outlined">
      <Card.Title
        title="Device health"
        left={() => <View style={[styles.healthDot, { backgroundColor: color }]} />}
      />
      <Card.Content>
        {rows.map((row, index) => (
          <View key={row.label}>
            <View style={styles.healthRow}>
              <Text variant="bodyMedium">{row.label}</Text>
              <Text variant="bodyMedium" style={styles.healthValue}>
                {row.value}
              </Text>
            </View>
            {index < rows.length - 1 ? <Divider /> : null}
          </View>
        ))}
      </Card.Content>
    </Card>
  );
};

const styles = StyleSheet.create({
  timeline: { gap: 0 },
  timelineRow: { flexDirection: 'row', gap: spacing(1.5) },
  timelineGutter: { alignItems: 'center', width: 16 },
  timelineDot: { width: 10, height: 10, borderRadius: 5, marginTop: 6 },
  timelineLine: { width: 2, flex: 1, marginVertical: 2 },
  timelineBody: { flex: 1, paddingBottom: spacing(2) },
  photoContent: { gap: spacing(1) },
  photo: { width: '100%', height: 200, borderRadius: 8, backgroundColor: '#E8EAED' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  chipText: { color: '#FFFFFF', fontSize: 11 },
  healthDot: { width: 14, height: 14, borderRadius: 7, marginLeft: 8 },
  healthRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6, gap: 12 },
  healthValue: { flexShrink: 1, textAlign: 'right' },
});
