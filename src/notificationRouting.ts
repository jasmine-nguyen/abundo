/**
 * Maps a push notification's `data.type` to the in-app route to open on tap (WHIT-321, WHIT-322).
 *
 * The server sends a domain `type` (e.g. "repayment"), never a route string — so the app
 * owns this map: renaming a screen never needs a server change, and adding a new deep-link
 * later is one line here.
 *
 * NOTIF_ROUTE maps a `type` to a fixed route. The one exception is a budget push: it carries
 * the internal category id and opens THAT category's screen (no id → nothing to open).
 */

export const NOTIF_ROUTE: Record<string, string> = {
  repayment: '/mortgage',
  milestone: '/milestone',
  goal: '/goals',
  goalcheckpoint: '/goals', // WHIT-479's checkpoint push deep-links to the goals list (WHIT-481)
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
  if (type === 'budget') {
    const category = (data as { category?: unknown }).category;
    return typeof category === 'string' && category ? `/budget/${category}` : null;
  }
  return NOTIF_ROUTE[type] ?? null;
}
