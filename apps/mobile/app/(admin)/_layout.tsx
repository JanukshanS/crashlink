/** Admin tabs (§2.2): devices, health, demo. */
import React from 'react';
import { Tabs } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

export default function AdminLayout() {
  const theme = useTheme();
  const { t } = useTranslation();

  return (
    <Tabs screenOptions={{ tabBarActiveTintColor: theme.colors.primary }}>
      <Tabs.Screen
        name="devices"
        options={{
          title: t('admin.devices'),
          tabBarIcon: ({ color, size }) => <MaterialCommunityIcons name="chip" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="health"
        options={{
          title: t('admin.health'),
          tabBarIcon: ({ color, size }) => (
            <MaterialCommunityIcons name="heart-pulse" color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="demo"
        options={{
          title: t('admin.demo'),
          tabBarIcon: ({ color, size }) => <MaterialCommunityIcons name="flask" color={color} size={size} />,
        }}
      />
    </Tabs>
  );
}
