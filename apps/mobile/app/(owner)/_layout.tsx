/**
 * Owner tabs (§2.2): index, bikes, incidents, insights, settings.
 * GUEST shares this group read-only (§2.1) and sees the demo banner.
 */
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Tabs } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Text, useTheme } from 'react-native-paper';
import { useTranslation } from 'react-i18next';
import { SafeAreaInsetsContext, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useIsReadOnly } from '../../src/stores/auth';
import { INFO_BLUE } from '../../src/theme';

export default function OwnerLayout() {
  const theme = useTheme();
  const { t } = useTranslation();
  const readOnly = useIsReadOnly();
  const insets = useSafeAreaInsets();

  return (
    <>
      {/* §2.3.1: judges must always know they are looking at seeded data. */}
      {readOnly ? (
        <View style={[styles.banner, { backgroundColor: INFO_BLUE, paddingTop: insets.top + 6 }]}>
          <Text style={styles.bannerText}>{t('auth.demoBanner')}</Text>
        </View>
      ) : null}

      {/* The banner already clears the status bar, so headers below it must not add the inset again. */}
      <SafeAreaInsetsContext.Provider value={readOnly ? { ...insets, top: 0 } : insets}>
      <Tabs
        screenOptions={{
          headerShown: true,
          tabBarActiveTintColor: theme.colors.primary,
          headerStyle: { backgroundColor: theme.colors.surface },
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: t('owner.dashboard'),
            tabBarIcon: ({ color, size }) => (
              <MaterialCommunityIcons name="view-dashboard" color={color} size={size} />
            ),
          }}
        />
        <Tabs.Screen
          name="bikes"
          options={{
            title: t('owner.bikes'),
            headerShown: false,
            tabBarIcon: ({ color, size }) => (
              <MaterialCommunityIcons name="motorbike" color={color} size={size} />
            ),
          }}
        />
        <Tabs.Screen
          name="incidents"
          options={{
            title: t('owner.incidents'),
            headerShown: false,
            tabBarIcon: ({ color, size }) => (
              <MaterialCommunityIcons name="alert-circle" color={color} size={size} />
            ),
          }}
        />
        <Tabs.Screen
          name="insights"
          options={{
            title: t('owner.insights'),
            tabBarIcon: ({ color, size }) => (
              <MaterialCommunityIcons name="chart-bar" color={color} size={size} />
            ),
          }}
        />
        <Tabs.Screen
          name="settings"
          options={{
            title: t('owner.settings'),
            tabBarIcon: ({ color, size }) => <MaterialCommunityIcons name="cog" color={color} size={size} />,
          }}
        />
      </Tabs>
      </SafeAreaInsetsContext.Provider>
    </>
  );
}

const styles = StyleSheet.create({
  banner: { paddingVertical: 6, paddingHorizontal: 12, alignItems: 'center' },
  bannerText: { color: '#FFFFFF', fontSize: 12, fontWeight: '700', letterSpacing: 0.4 },
});
