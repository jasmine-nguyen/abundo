import { describe, it, expect } from '@jest/globals';
import { routeForNotificationData, NOTIF_ROUTE, NOTIF_ROUTE_BUILDERS } from '../notificationRouting';

describe('routeForNotificationData (WHIT-321, WHIT-322)', () => {
  it('maps a repayment notification to the mortgage screen', () => {
    expect(routeForNotificationData({ type: 'repayment' })).toBe('/mortgage');
  });

  it('maps a milestone notification to the milestone-plan screen', () => {
    expect(routeForNotificationData({ type: 'milestone' })).toBe('/milestone');
  });

  it('maps a goal notification to the goals screen', () => {
    expect(routeForNotificationData({ type: 'goal' })).toBe('/goals');
  });

  it('maps a budget notification to that category’s budget screen', () => {
    expect(routeForNotificationData({ type: 'budget', category: 'groceries' })).toBe('/budget/groceries');
  });

  it('returns null for a budget notification with a missing/empty category', () => {
    expect(routeForNotificationData({ type: 'budget' })).toBeNull();
    expect(routeForNotificationData({ type: 'budget', category: '' })).toBeNull();
    expect(routeForNotificationData({ type: 'budget', category: 123 })).toBeNull();
  });

  it('has the expected static routes in the table', () => {
    expect(NOTIF_ROUTE.repayment).toBe('/mortgage');
    expect(NOTIF_ROUTE.milestone).toBe('/milestone');
    expect(NOTIF_ROUTE.goal).toBe('/goals');
  });

  it('exposes a budget route builder (not a static route)', () => {
    expect(NOTIF_ROUTE.budget).toBeUndefined();
    expect(typeof NOTIF_ROUTE_BUILDERS.budget).toBe('function');
  });

  it('returns null for an unmapped type', () => {
    expect(routeForNotificationData({ type: 'nope' })).toBeNull();
  });

  it('returns null when data is missing or not an object', () => {
    expect(routeForNotificationData(undefined)).toBeNull();
    expect(routeForNotificationData(null)).toBeNull();
    expect(routeForNotificationData('repayment')).toBeNull();
    expect(routeForNotificationData(42)).toBeNull();
  });

  it('returns null when type is absent or not a string', () => {
    expect(routeForNotificationData({})).toBeNull();
    expect(routeForNotificationData({ type: 123 })).toBeNull();
  });
});

// ===== WHIT-321 malformed data shapes (folded from notificationRouting.edges.logic.test.ts)
// WHIT-321 — routeForNotificationData: adversarial data-shape gaps the implementer's
// notificationRouting.logic.test.ts didn't lock (type null/array, data itself an array).
// Guards the null-return contract that keeps a malformed push from ever navigating.
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

// ===== WHIT-322 budget-builder edge cases (folded from notificationRouting.budget.edges.logic.test.ts)
// WHIT-322 — routeForNotificationData budget-builder edge cases the implementer's
// notificationRouting.logic.test.ts didn't lock. The implementer covered: valid string,
// missing, empty string, numeric. Gaps below: null/boolean category (typeof-object &
// falsy-string traps), the builder-wins-over-static contract, and the NON-ENCODING of ids
// that contain path-significant / non-ascii characters (documents current behaviour +
// flags the slash risk against the single-segment /budget/[id] route).
describe('budget route builder — falsy / wrong-type category (WHIT-322)', () => {
  it('[A30] category null → null (typeof null === "object", not a string)', () => {
    expect(routeForNotificationData({ type: 'budget', category: null })).toBeNull();
  });

  it('[A31] category boolean/true → null', () => {
    expect(routeForNotificationData({ type: 'budget', category: true })).toBeNull();
  });

  it('[A32] category as an object/array → null (no String() coercion into the path)', () => {
    expect(routeForNotificationData({ type: 'budget', category: { id: 'x' } })).toBeNull();
    expect(routeForNotificationData({ type: 'budget', category: ['x'] })).toBeNull();
  });

  it('[A33] category numeric 0 → null (falsy AND non-string)', () => {
    expect(routeForNotificationData({ type: 'budget', category: 0 })).toBeNull();
  });
});

describe('budget route builder — valid ids round-trip verbatim (WHIT-322)', () => {
  it('[A34] a normal Up slug with a hyphen builds the exact route', () => {
    expect(routeForNotificationData({ type: 'budget', category: 'good-life' })).toBe('/budget/good-life');
  });

  it('[A35] a non-ascii id passes through unchanged (no lossy transform)', () => {
    expect(routeForNotificationData({ type: 'budget', category: 'café' })).toBe('/budget/café');
  });

  it('[A36] the builder wins over the static map for the same type', () => {
    // Direct-call the builder to prove routeForNotificationData delegates to it, not NOTIF_ROUTE.
    expect(NOTIF_ROUTE_BUILDERS.budget({ category: 'groceries' })).toBe('/budget/groceries');
    expect(NOTIF_ROUTE_BUILDERS.budget({})).toBeNull();
  });
});

describe('budget route builder — DOCUMENTS CURRENT (unencoded) behaviour, see QA critique (WHIT-322)', () => {
  // These lock what the code does TODAY so an intentional fix (encodeURIComponent / trim)
  // trips the test and gets a deliberate review — they are NOT an endorsement.
  it('[A37] a slash in the id is NOT escaped → produces a multi-segment path (RISK: mis-routes /budget/[id])', () => {
    expect(routeForNotificationData({ type: 'budget', category: 'a/b' })).toBe('/budget/a/b');
  });

  it('[A38] a whitespace-only id is treated as present (length > 0, no trim) → routes to a blank id', () => {
    expect(routeForNotificationData({ type: 'budget', category: '   ' })).toBe('/budget/   ');
  });
});
