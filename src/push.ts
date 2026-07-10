import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { registerDevice } from './api';

// Present a foreground push — one arriving while the app is open — as a quiet-but-
// visible banner (WHIT-144): show the banner AND keep it in the notification centre,
// but no sound and no app-icon badge (the app's calm ethos). Without this, Expo
// discards a foregrounded notification by default. Registered ONCE at module scope
// because the handler must be set before any notification arrives; importing this
// module at launch (app/_layout.tsx) runs it. Skipped on web, where the native
// handler has no meaning — mirrors registerForPushNotificationsAsync's web bail.
//
// NB the four booleans are the current expo-notifications@56 NotificationBehavior
// shape (shouldShowBanner/shouldShowList replaced the deprecated shouldShowAlert).
if (Platform.OS !== 'web') {
  try {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: false,
        shouldSetBadge: false,
      }),
    });
  } catch {
    // Best-effort, like registerForPushNotificationsAsync below: installing the
    // handler must NEVER throw into app launch. It's a synchronous setter today, but
    // this keeps the module honest to the file's "never crash launch" contract.
  }
}

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
