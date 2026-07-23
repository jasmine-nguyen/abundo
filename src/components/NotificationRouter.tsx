import { useEffect, useRef } from 'react';
import * as Notifications from 'expo-notifications';
import { useRouter, useRootNavigationState } from 'expo-router';
import { routeForNotificationData } from '../notificationRouting';

/**
 * Deep-links a notification tap to the right screen (WHIT-321). Renders nothing.
 *
 * `useLastNotificationResponse` is the single source: it reports BOTH the tap that
 * cold-launched the app AND every tap while the app is running. We navigate once per
 * distinct tap — deduped by the notification's id, since the hook keeps returning the same
 * response across re-renders — and only after the root navigator is mounted.
 *
 * Mounted inside the router tree (app/_layout.tsx) so the router hooks resolve. If the user
 * is logged out/locked, AuthGate redirects to login first — the tap just opens the app (a
 * deliberate non-goal: we don't carry the deep-link across the login gate).
 */
export function NotificationRouter(): null {
  const router = useRouter();
  const navState = useRootNavigationState();
  const navReady = navState?.key != null;
  const lastResponse = Notifications.useLastNotificationResponse();
  const handledId = useRef<string | null>(null);

  useEffect(() => {
    if (!navReady || !lastResponse) return;
    const { identifier, content } = lastResponse.notification.request;
    if (handledId.current === identifier) return; // already navigated for this tap
    const route = routeForNotificationData(content.data);
    if (route) {
      handledId.current = identifier;
      router.push(route);
    }
  }, [navReady, lastResponse, router]);

  return null;
}
