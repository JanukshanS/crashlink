import React from 'react';
import { Stack } from 'expo-router';

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
