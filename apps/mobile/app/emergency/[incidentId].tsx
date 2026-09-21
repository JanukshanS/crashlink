/**
 * Emergency prompt (§2.4) - the highest-priority screen in the product.
 *
 * Full-screen, red, no tab bar, back disabled until resolved. Opens from three
 * independent triggers (socket, 5 s poll, notification tap) which all converge
 * on `emergencyStore`.
 *
 * Two rules drive everything here:
 *
 *  1. **The countdown runs on the server's clock.** It is
 *     `responseDeadlineAt - (Date.now() + clockOffset)`. A handset whose clock
 *     is a minute fast would otherwise tell a rider their window had closed
 *     while the server was still waiting for them.
 *
 *  2. **Never claim more than the server confirmed.** "Sending…" while
 *     in flight, "Accepted by server · syncing to bike" once it replies, and
 *     "Synced with bike ✓" only when `deviceSync === 'SYNCED'` - because until
 *     the bike acks, it is still running its own escalation timer.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BackHandler, StyleSheet, Vibration, View, ScrollView } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ActivityIndicator, Button, Surface, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';
import { createAudioPlayer, type AudioPlayer } from 'expo-audio';

import { useEmergencyStore } from '../../src/stores/emergency';
import { msUntil } from '../../src/stores/realtime';
import { useEmergencyResponse } from '../../src/api/hooks/useEmergencyResponse';
import { useIncident } from '../../src/api/hooks/useIncidents';
import { useActiveRental, useEmergencyContact } from '../../src/api/hooks/useIncidents';
import { DISPLAY_TZ } from '../../src/lib/format';
import { CallButtons } from '../../src/components/CallButtons';
import { EMERGENCY_BUTTON_HEIGHT, EMERGENCY_RED, SAFE_GREEN } from '../../src/theme';

/** §2.4: alarm + vibration loop until a button is pressed. */
const VIBRATION_PATTERN = [0, 600, 400, 600, 400];

const formatTime = (iso: string | null): string => {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleTimeString('en-GB', { timeZone: DISPLAY_TZ, hour: '2-digit', minute: '2-digit' });
};

export default function EmergencyScreen() {
  const { incidentId } = useLocalSearchParams<{ incidentId: string }>();
  const router = useRouter();
  const { t } = useTranslation();

  const question = useEmergencyStore((state) => state.question);
  const status = useEmergencyStore((state) => state.status);
  const choice = useEmergencyStore((state) => state.choice);
  const losingDecision = useEmergencyStore((state) => state.losingDecision);
  const resolve = useEmergencyStore((state) => state.resolve);

  const { respond, acknowledgeQuestion } = useEmergencyResponse(incidentId);
  const incident = useIncident(incidentId);
  const activeRental = useActiveRental();

  const player = useRef<AudioPlayer | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number>(() =>
    Math.ceil(msUntil(question?.responseDeadlineAt) / 1000),
  );

  const answered = status === 'accepted' || status === 'synced';
  const finished = answered || status === 'tooLate';

  // --- countdown on server time (§2.4) -------------------------------------
  useEffect(() => {
    if (!question) return;

    const tick = (): void => {
      setSecondsLeft(Math.ceil(msUntil(question.responseDeadlineAt) / 1000));
    };

    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [question]);

  // --- alarm + vibration ----------------------------------------------------
  useEffect(() => {
    if (finished) return;

    Vibration.vibrate(VIBRATION_PATTERN, true);

    try {
      // The alarm file ships with the app; if it is missing the vibration and
      // the red screen still do their job rather than crashing the screen.
      const instance = createAudioPlayer(require('../../assets/alarm.wav'));
      instance.loop = true;
      instance.volume = 1;
      instance.play();
      player.current = instance;
    } catch {
      player.current = null;
    }

    return () => {
      Vibration.cancel();
      player.current?.remove();
      player.current = null;
    };
  }, [finished]);

  useEffect(() => {
    if (!finished) return;
    Vibration.cancel();
    player.current?.pause();
  }, [finished]);

  // --- §2.4: post question-ack on open -------------------------------------
  useEffect(() => {
    void acknowledgeQuestion();
  }, [acknowledgeQuestion]);

  // --- back button disabled until resolved (§2.4) --------------------------
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => !finished);
    return () => subscription.remove();
  }, [finished]);

  const onAnswer = useCallback(
    async (selected: 'SAFE' | 'HELP') => {
      const result = await respond(selected);
      if (result?.accepted && incidentId) resolve(incidentId);
    },
    [respond, incidentId, resolve],
  );

  const close = useCallback(() => {
    if (incidentId) resolve(incidentId);
    router.replace('/(driver)' as never);
  }, [incidentId, resolve, router]);

  // --- status line (§2.4) ---------------------------------------------------
  const statusLine = useMemo(() => {
    switch (status) {
      case 'sending':
        return { text: t('emergency.sending'), spinner: true };
      case 'accepted':
        return { text: t('emergency.acceptedSyncing'), spinner: true };
      case 'synced':
        return { text: t('emergency.synced'), spinner: false };
      case 'tooLate':
        return {
          // The losing-decision payload can arrive without a time; the incident has it.
          text: t('emergency.tooLate', {
            time: formatTime(losingDecision?.decidedAt ?? incident.data?.decidedAt ?? null),
          }),
          spinner: false,
        };
      case 'offline':
        return { text: t('emergency.cannotReach'), spinner: true };
      default:
        return null;
    }
  }, [status, t, losingDecision, incident.data?.decidedAt]);

  const detail = incident.data;
  // §5.7.3 masks the snapshot in driver-facing views, and a masked number
  // cannot be dialled. The rider's own current contact is their own data (RW
  // own, §5.7.2), so it is the call target when the snapshot is masked.
  // TODO(spec): the contact the bike texted is the snapshot; if the rider changed
  // it mid-rental (FR-DRV-04) this dials the newer one.
  const ownContact = useEmergencyContact();
  const snapshotPhone = detail?.contact?.phone ?? null;
  const contactPhone =
    snapshotPhone && !snapshotPhone.includes('•') ? snapshotPhone : (ownContact.data?.phone ?? null);
  const ownerPhone = activeRental.data?.rental?.ownerPhone ?? null;

  // MANUAL_SOS never asks a question - it tells the rider help is coming.
  const isSos = detail?.type === 'MANUAL_SOS';

  return (
    <Surface style={styles.root} elevation={0}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text variant="displaySmall" style={styles.title}>
          {isSos ? t('emergency.sosTitle') : t('emergency.title')}
        </Text>

        {/* Appendix D: the label comes from the API verbatim, "Possible …". */}
        {question?.label || detail?.label ? (
          <Text variant="titleMedium" style={styles.label}>
            {detail?.label ?? question?.label}
          </Text>
        ) : null}

        {!finished && !isSos ? (
          <Text variant="displayLarge" style={styles.countdown}>
            {t('emergency.secondsLeft', { count: Math.max(0, secondsLeft) })}
          </Text>
        ) : null}

        {isSos ? <Text style={styles.body}>{t('emergency.sosBody')}</Text> : null}

        {statusLine ? (
          <View style={styles.statusRow}>
            {statusLine.spinner ? <ActivityIndicator color="#FFFFFF" size="small" /> : null}
            <Text style={styles.status}>{statusLine.text}</Text>
          </View>
        ) : null}

        {/* --- the two buttons (>= 72 dp, NFR-08) --- */}
        {!finished && !isSos ? (
          <View style={styles.buttons}>
            <Button
              mode="contained"
              buttonColor={SAFE_GREEN}
              textColor="#FFFFFF"
              onPress={() => void onAnswer('SAFE')}
              disabled={status === 'sending'}
              style={styles.bigButton}
              contentStyle={styles.bigButtonContent}
              labelStyle={styles.bigLabel}
            >
              {t('emergency.safe')}
            </Button>

            <Button
              mode="contained"
              buttonColor="#7A0C16"
              textColor="#FFFFFF"
              onPress={() => void onAnswer('HELP')}
              disabled={status === 'sending'}
              style={styles.bigButton}
              contentStyle={styles.bigButtonContent}
              labelStyle={styles.bigLabel}
            >
              {t('emergency.help')}
            </Button>
          </View>
        ) : null}

        {/* --- after HELP, or after SOS (§2.4) --- */}
        {(choice === 'HELP' && answered) || isSos ? (
          <View style={styles.afterHelp}>
            <Text style={styles.body}>{t('emergency.helpOnItsWay')}</Text>
            <CallButtons
              targets={[
                { label: t('emergency.callContact'), phone: contactPhone, emphasis: true },
                { label: t('emergency.callOwner'), phone: ownerPhone },
              ]}
            />
          </View>
        ) : null}

        {choice === 'SAFE' && answered ? (
          <Text style={styles.body}>{t('emergency.resolvedSafe')}</Text>
        ) : null}

        {/* D7: somebody else decided first - say what won, and when. */}
        {status === 'tooLate' ? (
          <View style={styles.afterHelp}>
            <CallButtons
              targets={[{ label: t('emergency.callContact'), phone: contactPhone, emphasis: true }]}
            />
          </View>
        ) : null}

        {finished ? (
          <Button mode="outlined" textColor="#FFFFFF" onPress={close} style={styles.close}>
            {t('common.close')}
          </Button>
        ) : null}

        <Text style={styles.disclaimer}>{t('emergency.notEmergencyService')}</Text>
      </ScrollView>
    </Surface>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: EMERGENCY_RED },
  content: { padding: 24, paddingTop: 64, gap: 16, flexGrow: 1 },
  title: { color: '#FFFFFF', fontWeight: '800', textAlign: 'center' },
  label: { color: '#FFE3E1', textAlign: 'center' },
  countdown: { color: '#FFFFFF', fontWeight: '900', textAlign: 'center', marginVertical: 8 },
  body: { color: '#FFFFFF', fontSize: 16, textAlign: 'center', lineHeight: 24 },
  statusRow: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 32,
  },
  status: { color: '#FFFFFF', fontSize: 15, flexShrink: 1, textAlign: 'center' },
  buttons: { gap: 16, marginTop: 8 },
  bigButton: { borderRadius: 12 },
  bigButtonContent: { height: EMERGENCY_BUTTON_HEIGHT },
  bigLabel: { fontSize: 24, fontWeight: '800', lineHeight: 30 },
  afterHelp: { gap: 12, marginTop: 8 },
  close: { borderColor: '#FFFFFF', marginTop: 8 },
  disclaimer: { color: '#FFD9D6', fontSize: 12, textAlign: 'center', marginTop: 'auto', paddingTop: 24 },
});
