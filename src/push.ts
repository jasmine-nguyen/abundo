import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { registerDevice } from './api';

/**
 * Ask for notification permission (once — never re-nagging a hard denial), get
 * this device's Expo push token, and register it with the server so pushes can be
 * delivered.
 *
 * BEST-EFFORT by design: web, a permission denial, a simulator, a missing
 * projectId, or an offline POST all resolve to a silent no-op. The whole body is
 * wrapped so this can NEVER throw into app launch — a push we can't set up is not
 * an error worth surfacing (mirrors the app's "honest empty state, never crash"
 * ethos). A real token only materialises on a physical device build (not web,
 * simulator, or Expo Go), so every non-device path deliberately bails quietly.
 */
export async function registerForPushNotificationsAsync(): Promise<void> {
  try {
    // Web has no reliable Expo push token here — bail before touching the native module.
    if (Platform.OS === 'web') return;

    const { status: existing, canAskAgain } = await Notifications.getPermissionsAsync();
    let status = existing;
    // Prompt only when the user hasn't decided yet AND the OS will still ask — a
    // prior hard denial is left untouched (the card's "no nagging").
    if (status !== 'granted' && canAskAgain) {
      status = (await Notifications.requestPermissionsAsync()).status;
    }
    if (status !== 'granted') return;

    // getExpoPushTokenAsync needs the EAS projectId (app.json extra.eas.projectId).
    const projectId = Constants.expoConfig?.extra?.eas?.projectId;
    if (!projectId) return;

    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    if (!token) return; // never POST an empty/undefined token — the server would 400
    await registerDevice(token);
  } catch {
    // Simulator / denied / offline / no token — stay silent, never crash launch.
  }
}
