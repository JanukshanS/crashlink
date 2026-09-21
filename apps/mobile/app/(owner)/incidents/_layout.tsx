import React from 'react';
// JS stack, not native: its header honours the owner layout's inset override, so
// it does not add the status bar a second time under the judge's demo banner.
import Stack from 'expo-router/js-stack';

// Without this layout, expo-router listed incidents/[id] as a tab of its own.
export default function IncidentsLayout() {
  return (
    <Stack>
      <Stack.Screen name="index" options={{ title: 'Incidents' }} />
      <Stack.Screen name="[id]" options={{ title: 'Incident' }} />
    </Stack>
  );
}
