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
 * Fetch this device's EXPO push token and register it with the server. Shared by the
 * one-shot launch registration and the rotation listener so the two can't drift.
 *
 * When `devicePushToken` is supplied (the rotation path), it's passed straight into
 * getExpoPushTokenAsync so Expo does NOT internally call getDevicePushTokenAsync —
 * which would re-emit the rotation event and infinite-loop (see registerPushTokenRotation).
 * The one-shot path omits it, keeping the original `{ projectId }`-only call shape.
 */
async function fetchAndRegisterExpoToken(
  projectId: string,
  devicePushToken?: Notifications.DevicePushToken,
): Promise<void> {
  const { data: token } = await Notifications.getExpoPushTokenAsync(
    devicePushToken ? { projectId, devicePushToken } : { projectId },
  );
  if (!token) return; // never POST an empty/undefined token — the server would 400
  await registerDevice(token);
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

    await fetchAndRegisterExpoToken(projectId);   // no device token → the one-shot path
  } catch (err) {
    // Simulator / denied / offline / no token — never crash launch. But LOG the reason
    // rather than swallow it: a silent catch here hid a real getExpoPushTokenAsync
    // failure (a renamed app whose build lacked push credentials) that made "no
    // notifications" undiagnosable. A console.warn surfaces it in dev/logs without
    // surfacing anything to the user.
    console.warn('[push] registerForPushNotificationsAsync failed:', err);
  }
}

/**
 * Re-register the device's Expo push token whenever the push service rotates it
 * mid-session (WHIT-145). Registration otherwise runs once per launch, so a rotation
 * would leave the server holding a stale token until the next launch.
 *
 * The listener receives the RAW DEVICE token ({ type, data } — an FCM/APNs value),
 * NOT the Expo token the server wants; we hand that object straight to
 * getExpoPushTokenAsync as `devicePushToken` so it re-maps to the fresh Expo token
 * AND skips its internal getDevicePushTokenAsync — which would re-emit this same event
 * and infinite-loop (Expo's own docs warn about exactly this). We never forward the
 * device token to registerDevice.
 *
 * BEST-EFFORT: web is a no-op (returns undefined, no listener); installing the listener
 * and each rotation re-register are wrapped so nothing throws into launch. Returns the
 * EventSubscription so the caller can .remove() it on unmount — the listener is additive,
 * so it must never be installed twice.
 */
export function registerPushTokenRotation(): Notifications.EventSubscription | undefined {
  if (Platform.OS === 'web') return undefined;
  try {
    return Notifications.addPushTokenListener((token) => {
      // The listener signature is sync (void), so fire-and-forget; the inner try/catch
      // keeps a failed re-register silent (the next launch re-registers anyway).
      void (async () => {
        try {
          const projectId = Constants.expoConfig?.extra?.eas?.projectId;
          if (!projectId) return;
          await fetchAndRegisterExpoToken(projectId, token);
        } catch (err) {
          // Offline / no token / permission gone — best-effort, never crash; log the
          // reason so a rotation re-register failure is diagnosable (the next launch
          // re-registers anyway).
          console.warn('[push] token-rotation re-register failed:', err);
        }
      })();
    });
  } catch {
    return undefined; // installing the listener must never crash launch
  }
}
