// WHIT-321 — routeForNotificationData: adversarial data-shape gaps the implementer's
// notificationRouting.logic.test.ts didn't lock (type null/array, data itself an array).
// Guards the null-return contract that keeps a malformed push from ever navigating.
import { describe, it, expect } from '@jest/globals';
import { routeForNotificationData } from '../notificationRouting';

describe('routeForNotificationData — malformed data shapes (WHIT-321)', () => {
  it('returns null when type is explicitly null', () => {
    // [A20] typeof null === 'object' — the guard is on `type`, not `data`, so this must
    // still fall through to null rather than index NOTIF_ROUTE[null].
    expect(routeForNotificationData({ type: null })).toBeNull();
  });

  it('returns null when type is an array', () => {
    // [A21] arrays are objects; type must be a *string* to map.
    expect(routeForNotificationData({ type: ['repayment'] })).toBeNull();
  });

  it('returns null when type is a nested object', () => {
    // [A22] no accidental String(obj) coercion into the route table.
    expect(routeForNotificationData({ type: { name: 'repayment' } })).toBeNull();
  });

  it('returns null when type is boolean', () => {
    expect(routeForNotificationData({ type: true })).toBeNull();
  });

  it('returns null when data itself is an array (an object, but no string type)', () => {
    // [A23] `typeof [] === 'object'` and an array is truthy, so it passes the first
    // guard — it must still resolve to null via the missing `.type`.
    expect(routeForNotificationData([])).toBeNull();
    expect(routeForNotificationData(['repayment'])).toBeNull();
  });

  it('does not treat empty-string type as a route', () => {
    // [A24] '' is a string but not a key — must be null, not undefined-throw.
    expect(routeForNotificationData({ type: '' })).toBeNull();
  });
});
