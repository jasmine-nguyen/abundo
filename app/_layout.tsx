import React, { useEffect } from 'react';
import { Platform, View, StyleSheet } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as SplashScreen from 'expo-splash-screen';
import { C } from '../src/theme';
import { AppProvider } from '../src/context';
import { Overlays } from '../src/components/Overlays';
import { registerForPushNotificationsAsync } from '../src/push';

SplashScreen.preventAutoHideAsync().catch(() => {});

const GOOGLE_FONTS_HREF =
  'https://fonts.googleapis.com/css2?family=Inter+Tight:wght@400;500;600;700;800&family=Inter:wght@400;450;500;600;700&display=swap';

function useAppFonts(): boolean {
  // Web: rely on the Google Fonts stylesheet so fontWeight maps to real faces.
  if (Platform.OS === 'web') {
    useEffect(() => {
      if (typeof document === 'undefined') return;
      if (document.querySelector('link[data-whittle-fonts]')) return;
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = GOOGLE_FONTS_HREF;
      link.setAttribute('data-whittle-fonts', '1');
      document.head.appendChild(link);
    }, []);
    return true;
  }
  // Native: register a representative weight per family via expo-font.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { useFonts, Inter_500Medium, Inter_700Bold } = require('@expo-google-fonts/inter');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { InterTight_800ExtraBold } = require('@expo-google-fonts/inter-tight');
  const [loaded] = useFonts({
    Inter: Inter_500Medium,
    'Inter-Bold': Inter_700Bold,
    'Inter Tight': InterTight_800ExtraBold,
  });
  return loaded;
}

export default function RootLayout() {
  const ready = useAppFonts();

  useEffect(() => {
    if (ready) SplashScreen.hideAsync().catch(() => {});
  }, [ready]);

  // Once per launch: ask notification permission + register this device's push
  // token. Best-effort (never throws); a no-op on web/simulator/denial.
  useEffect(() => {
    registerForPushNotificationsAsync();
  }, []);

  if (!ready) return <View style={{ flex: 1, backgroundColor: C.bg }} />;

  const isWeb = Platform.OS === 'web';

  const app = (
    <View style={isWeb ? styles.deviceWeb : styles.deviceNative}>
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: C.bg },
          animation: 'slide_from_right',
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="(tabs)" />
      </Stack>
      <Overlays />
    </View>
  );

  return (
    <SafeAreaProvider>
      <AppProvider>
        <StatusBar style="light" />
        {isWeb ? <View style={styles.backdrop}>{app}</View> : app}
      </AppProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  // On web, frame the app at phone width and center it against a darker backdrop.
  backdrop: { flex: 1, backgroundColor: C.bgDeep, alignItems: 'center' },
  deviceWeb: {
    flex: 1,
    width: '100%',
    maxWidth: 440,
    backgroundColor: C.bg,
    overflow: 'hidden',
    ...(Platform.OS === 'web' ? { boxShadow: '0 0 60px rgba(0,0,0,0.6)' } : null),
  },
  deviceNative: { flex: 1, backgroundColor: C.bg },
});
