import React from 'react';
// JS stack, not native: its header honours the owner layout's inset override, so
// it does not add the status bar a second time under the judge's demo banner.
import Stack from 'expo-router/js-stack';

export default function BikesLayout() {
  return (
    <Stack>
      <Stack.Screen name="index" options={{ title: 'Bikes' }} />
      <Stack.Screen name="add" options={{ title: 'Add bike', presentation: 'modal' }} />
      <Stack.Screen name="[id]/index" options={{ title: 'Bike' }} />
      <Stack.Screen name="[id]/assign" options={{ title: 'Assign rental' }} />
      <Stack.Screen name="[id]/config" options={{ title: 'Device settings' }} />
    </Stack>
  );
}
