/**
 * Incident detail (§2.3.6).
 *
 * header · photo panel · map + freshness · timeline · evidence · response ·
 * notifications · call buttons · acknowledge.
 *
 * Notification rows go through NotificationStateChip so none of them can say
 * "delivered" for an AT_SUBMITTED SMS (FR-NOT-02).
 */
import React, { useState } from 'react';
import { Linking, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Button, Card, Chip, Dialog, Divider, Portal, Text, TextInput, useTheme } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import {
  useAcknowledgeIncident,
  useIncident,
  useIncidentImageUrl,
} from '../../../src/api/hooks/useIncidents';
import { useIsReadOnly } from '../../../src/stores/auth';
import { API_BASE_URL } from '../../../src/api/client';
import { FreshnessBadge } from '../../../src/components/FreshnessBadge';
import { LeafletMap } from '../../../src/components/LeafletMap';
import { CallButtons } from '../../../src/components/CallButtons';
import { NotificationStateChip } from '../../../src/components/NotificationStateChip';
import { IncidentTimeline, PhotoPanel } from '../../../src/components/IncidentTimeline';
import { BlackBoxChart } from '../../../src/components/BlackBoxChart';
import { severityApplies } from '../../../src/lib/format';
import { CATEGORY_COLORS, EMERGENCY_RED, SAFE_GREEN, SECURITY_AMBER, spacing } from '../../../src/theme';

const severityColor = (label: string): string => {
  switch (label) {
    case 'HIGH':
    case 'SOS':
      return EMERGENCY_RED;
    case 'MODERATE':
      return SECURITY_AMBER;
    default:
      return SAFE_GREEN;
  }
};

export default function IncidentDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const theme = useTheme();
  const { t } = useTranslation();

  const incident = useIncident(id);
  const readOnly = useIsReadOnly();
  const acknowledge = useAcknowledgeIncident(id ?? '');

  const data = incident.data;
  // §5.7.2: the judge gets a placeholder, so the signed URL is never requested.
  const image = useIncidentImageUrl(
    id,
    !readOnly && data?.photo?.status === 'AVAILABLE' && !data.photo.expired,
  );

  const [ackOpen, setAckOpen] = useState(false);
  const [note, setNote] = useState('');

  if (!data) {
    return (
      <ScrollView contentContainerStyle={styles.container}>
        <Text>{incident.isLoading ? t('common.loading') : t('common.error')}</Text>
      </ScrollView>
    );
  }

  const evidence = data.evidence as Record<string, number | boolean | null | undefined>;

  return (
    <ScrollView
      contentContainerStyle={styles.container}
      refreshControl={
        <RefreshControl refreshing={incident.isFetching} onRefresh={() => void incident.refetch()} />
      }
    >
      {/* --- header --- */}
      <Card mode="elevated">
        <Card.Content style={styles.section}>
          {/* Appendix D: the label as the API returns it, starting "Possible". */}
          <Text variant="headlineSmall" style={styles.title}>
            {data.label}
          </Text>

          <View style={styles.row}>
            <Chip compact style={{ backgroundColor: CATEGORY_COLORS[data.category] }} textStyle={styles.chipText}>
              {data.category}
            </Chip>
            {severityApplies(data.severity) ? (
              <Chip
                compact
                style={{ backgroundColor: severityColor(data.severity.label) }}
                textStyle={styles.chipText}
              >
                {data.severity.label}
                {data.severity.score !== null ? ` · ${data.severity.score}` : ''}
              </Chip>
            ) : null}
            <Chip compact>{data.state}</Chip>
            <Chip compact>{data.decision}</Chip>
          </View>

          {/* §5.6.5: the disclaimer travels with the number, always. */}
          {severityApplies(data.severity) ? (
            <Text variant="bodySmall" style={styles.disclaimer}>
              {data.severity.score !== null
                ? `Severity ${data.severity.score} / 100 · ${data.severity.note}`
                : 'SOS pressed - no sensor score is calculated for a button press.'}
            </Text>
          ) : null}

          {data.quarantined ? (
            <Text variant="bodySmall" style={{ color: theme.colors.error }}>
              {t('incident.quarantined')}
            </Text>
          ) : null}

          <Text variant="bodySmall">
            {new Date(data.occurredAt).toLocaleString('en-GB', { timeZone: 'Asia/Colombo' })} ·{' '}
            {data.bike.label}
          </Text>
        </Card.Content>
      </Card>

      {/* --- photo (owner only; the API omits it for drivers) --- */}
      <PhotoPanel
        status={data.photo?.status ?? 'NOT_REQUESTED'}
        integrity={data.photo?.integrity ?? null}
        bytes={data.photo?.bytes ?? null}
        progress={data.photo?.progress ?? null}
        expired={data.photo?.expired ?? false}
        restricted={readOnly}
        imageUrl={image.data ? `${API_BASE_URL}${image.data.url}` : null}
      />

      {/* --- location --- */}
      <Card mode="outlined">
        <Card.Title title="Location" />
        <Card.Content style={styles.section}>
          <FreshnessBadge
            location={{
              kind: data.location.kind,
              ageSec: data.location.ageSecondsAtEvent,
              source: (data.location as { source?: 'GPS' | 'DEMO' | null }).source ?? null,
            }}
            compact
            atEvent
          />

          {data.location.lat !== null && data.location.lon !== null ? (
            <>
              <LeafletMap
                height={200}
                markers={[
                  {
                    id: data.id,
                    lat: data.location.lat,
                    lon: data.location.lon,
                    label: data.label,
                    color: CATEGORY_COLORS[data.category],
                  },
                ]}
              />
              <Text variant="bodySmall">
                {data.location.lat.toFixed(5)}, {data.location.lon.toFixed(5)}
              </Text>
              <Button
                mode="outlined"
                icon="map-marker"
                onPress={() =>
                  void Linking.openURL(
                    `https://maps.google.com/?q=${data.location.lat},${data.location.lon}`,
                  )
                }
              >
                {t('common.openInMaps')}
              </Button>
            </>
          ) : (
            <Text variant="bodySmall">Location unavailable for this incident</Text>
          )}
        </Card.Content>
      </Card>

      {/* --- evidence --- */}
      <Card mode="outlined">
        <Card.Title title={t('incident.evidence')} />
        <Card.Content>
          <EvidenceRow label={t('incident.preEventSpeed')} value={data.preEventSpeedKph !== null ? `${data.preEventSpeedKph} km/h` : '—'} />
          <Divider />
          <EvidenceRow label={t('incident.peakG')} value={evidence.peakAccelerationG ? `${evidence.peakAccelerationG} g` : '—'} />
          <Divider />
          <EvidenceRow label={t('incident.peakRotation')} value={evidence.peakRotationDps ? `${evidence.peakRotationDps} °/s` : '—'} />
          <Divider />
          <EvidenceRow
            label={t('incident.fallenFor')}
            value={evidence.fallenDurationMs ? `${Math.round(Number(evidence.fallenDurationMs) / 1000)} s` : '—'}
          />
          <Divider />
          <EvidenceRow label={t('incident.ignition')} value={data.ignitionAtEvent} />
          {evidence.simulated ? (
            <Text variant="bodySmall" style={styles.simulated}>
              Simulated event
            </Text>
          ) : null}
        </Card.Content>
      </Card>

      {/* --- black box (FR-INC-12) --- */}
      <Card mode="outlined">
        <Card.Title title="Black box" subtitle="Sensor readings around the event" titleVariant="titleMedium" />
        <Card.Content>
          <BlackBoxChart
            sensorWindow={data.sensorWindow}
            occurredAt={data.occurredAt}
            simulated={Boolean(evidence.simulated)}
          />
        </Card.Content>
      </Card>

      {/* --- rider response --- */}
      <Card mode="outlined">
        <Card.Title title={t('incident.response')} />
        <Card.Content style={styles.section}>
          {data.responses.length === 0 ? (
            <Text variant="bodySmall">No response from the rider</Text>
          ) : (
            data.responses.map((response, index) => (
              <View key={index} style={styles.responseRow}>
                <Text variant="bodyMedium">
                  {response.choice} · {response.source}
                </Text>
                {/* D7: a refused response is shown honestly with its reason. */}
                <Chip
                  compact
                  style={{ backgroundColor: response.accepted ? SAFE_GREEN : SECURITY_AMBER }}
                  textStyle={styles.chipText}
                >
                  {response.accepted ? 'accepted' : (response.reason ?? 'not accepted')}
                </Chip>
              </View>
            ))
          )}
        </Card.Content>
      </Card>

      {/* --- notifications --- */}
      <Card mode="outlined">
        <Card.Title title={t('incident.notifications')} />
        <Card.Content style={styles.section}>
          {data.notifications.map((notification) => (
            <View key={notification.kind} style={styles.notificationRow}>
              <View style={styles.main}>
                <Text variant="bodyMedium">{notification.kind}</Text>
                <Text variant="bodySmall">{notification.recipientMasked ?? '—'}</Text>
              </View>
              <NotificationStateChip state={notification.state} compact />
            </View>
          ))}
        </Card.Content>
      </Card>

      {/* --- timeline --- */}
      <Card mode="outlined">
        <Card.Title title={t('incident.timeline')} />
        <Card.Content>
          <IncidentTimeline entries={data.timeline} />
        </Card.Content>
      </Card>

      {/* --- actions --- */}
      <CallButtons
        targets={[
          { label: t('emergency.callDriver'), phone: data.rental?.driverPhone, emphasis: true },
          { label: t('emergency.callContact'), phone: data.contact?.phone },
        ]}
      />

      {readOnly || data.ownerAckAt ? null : (
        <Button mode="contained" icon="check" onPress={() => setAckOpen(true)}>
          {t('owner.acknowledge')}
        </Button>
      )}

      {data.ownerAckAt ? (
        <Text variant="bodySmall">
          Acknowledged {new Date(data.ownerAckAt).toLocaleString('en-GB', { timeZone: 'Asia/Colombo' })}
          {data.ownerNote ? ` · ${data.ownerNote}` : ''}
        </Text>
      ) : null}

      <Portal>
        <Dialog visible={ackOpen} onDismiss={() => setAckOpen(false)}>
          <Dialog.Title>{t('owner.acknowledge')}</Dialog.Title>
          <Dialog.Content>
            <TextInput
              label="Note (optional)"
              value={note}
              onChangeText={setNote}
              mode="outlined"
              multiline
              placeholder="Rider called, minor scratches"
            />
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setAckOpen(false)}>{t('common.cancel')}</Button>
            <Button
              onPress={() => {
                acknowledge.mutate(note.trim() || undefined, { onSuccess: () => setAckOpen(false) });
              }}
              loading={acknowledge.isPending}
            >
              {t('common.confirm')}
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </ScrollView>
  );
}

const EvidenceRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <View style={styles.evidenceRow}>
    <Text variant="bodyMedium">{label}</Text>
    <Text variant="bodyMedium">{value}</Text>
  </View>
);

const styles = StyleSheet.create({
  container: { padding: spacing(2), gap: spacing(1.5) },
  section: { gap: spacing(1) },
  title: { fontWeight: '700' },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chipText: { color: '#FFFFFF', fontSize: 11 },
  disclaimer: { opacity: 0.7, fontStyle: 'italic' },
  evidenceRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 },
  responseRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  notificationRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  main: { flex: 1 },
  simulated: { marginTop: 8, opacity: 0.7 },
});
