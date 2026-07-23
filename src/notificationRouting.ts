/**
 * Maps a push notification's `data.type` to the in-app route to open on tap (WHIT-321, WHIT-322).
 *
 * The server sends a domain `type` (e.g. "repayment"), never a route string — so the app
 * owns this map: renaming a screen never needs a server change, and adding a new deep-link
 * later is one line here.
 *
 * Two layers:
 *  - NOTIF_ROUTE          — a `type` → fixed route (repayment/milestone → the mortgage screen,
 *                           goal → the goals list).
 *  - NOTIF_ROUTE_BUILDERS — a `type` → function that builds the route from the notification's
 *                           own fields, for a screen that needs an id (a budget push opens THAT
 *                           category's screen). A builder returning null → nowhere to open.
 * A builder wins over the static map when both exist for a type.
 */

export const NOTIF_ROUTE: Record<string, string> = {
  repayment: '/mortgage',
  milestone: '/mortgage',
  goal: '/goals',
};

export const NOTIF_ROUTE_BUILDERS: Record<string, (data: Record<string, unknown>) => string | null> = {
  // A budget push carries the internal category id → open that category's budget screen.
  // Missing/empty id → null (nothing to open, just foreground the app).
  budget: (data) =>
    typeof data.category === 'string' && data.category.length > 0
      ? `/budget/${data.category}`
      : null,
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
  const builder = NOTIF_ROUTE_BUILDERS[type];
  if (builder) return builder(data as Record<string, unknown>);
  return NOTIF_ROUTE[type] ?? null;
}
