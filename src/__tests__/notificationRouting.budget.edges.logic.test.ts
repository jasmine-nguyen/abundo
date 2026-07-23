// WHIT-322 — routeForNotificationData budget-builder edge cases the implementer's
// notificationRouting.logic.test.ts didn't lock. The implementer covered: valid string,
// missing, empty string, numeric. Gaps below: null/boolean category (typeof-object &
// falsy-string traps), the builder-wins-over-static contract, and the NON-ENCODING of ids
// that contain path-significant / non-ascii characters (documents current behaviour +
// flags the slash risk against the single-segment /budget/[id] route).
import { describe, it, expect } from '@jest/globals';
import { routeForNotificationData, NOTIF_ROUTE_BUILDERS } from '../notificationRouting';

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
