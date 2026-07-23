/**
 * Maps a push notification's `data.type` to the in-app route to open on tap (WHIT-321).
 *
 * The server sends a domain `type` (e.g. "repayment"), never a route string — so the app
 * owns this map: renaming a screen never needs a server change, and adding a milestone or
 * budget deep-link later is one line here.
 */

export const NOTIF_ROUTE: Record<string, string> = {
  repayment: '/mortgage',
};

/**
 * The route for a notification's `data`, or null when there's nothing to open —
 * missing/garbage data, no `type`, or a `type` with no mapping (a tap then just
 * foregrounds the app, as before).
 */
export function routeForNotificationData(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const type = (data as { type?: unknown }).type;
  if (typeof type !== 'string') return null;
  return NOTIF_ROUTE[type] ?? null;
}
