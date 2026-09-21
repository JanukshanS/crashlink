/**
 * Demo controls (§2.3.7, FR-DEMO-03).
 *
 * `POST /demo/reset` and `POST /demo/scenario` are not on the backend yet, so
 * this screen documents the equivalent commands instead of offering buttons
 * that would fail in front of a judge.
 */
import React from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { Card, Divider, Text } from 'react-native-paper';
import { spacing } from '../../src/theme';

const COMMANDS: { title: string; command: string; note: string }[] = [
  {
    title: 'Reset demo data',
    command: 'npm run db:seed -w apps/api',
    note: 'Clears demo incidents, rentals and traces, then rebuilds 14 days of history.',
  },
  {
    title: 'Provision a device',
    command: 'npm run device:provision -w apps/api -- --code CL-0003',
    note: 'Prints the secret once. Flash it into the board.',
  },
  {
    title: 'Run a crash scenario',
    command: 'npm run sim -w tools/device-sim -- collision-timeout --device CL-0002',
    note: 'Drives the real device protocol: fall, incident, SMS states, control poll, image upload.',
  },
  {
    title: 'Firmware signing vector',
    command: 'npm run sim -w tools/device-sim -- vector --secret <hex>',
    note: 'Canonical string plus expected signature, for checking the ESP32.',
  },
];

export default function AdminDemo() {
  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Card mode="outlined">
        <Card.Title title="Demo controls" subtitle="Run from the repo root" />
        <Card.Content>
          {COMMANDS.map((entry, index) => (
            <React.Fragment key={entry.title}>
              <Text variant="titleSmall" style={styles.title}>
                {entry.title}
              </Text>
              <Text variant="bodySmall" selectable style={styles.command}>
                {entry.command}
              </Text>
              <Text variant="bodySmall" style={styles.note}>
                {entry.note}
              </Text>
              {index < COMMANDS.length - 1 ? <Divider style={styles.divider} /> : null}
            </React.Fragment>
          ))}
        </Card.Content>
      </Card>

      <Text variant="bodySmall" style={styles.footer}>
        In-app demo triggers arrive with POST /demo/reset and POST /demo/scenario.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: spacing(2), gap: spacing(1.5) },
  title: { marginTop: 8 },
  command: { fontFamily: 'monospace', marginVertical: 4 },
  note: { opacity: 0.7 },
  divider: { marginVertical: 8 },
  footer: { opacity: 0.7, textAlign: 'center' },
});
