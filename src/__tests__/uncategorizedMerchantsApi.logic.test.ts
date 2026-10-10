// WHIT-517 — the "file by shop" select guard. The screen maps over `groups`, so a wrapped/changed
// shape must surface as the screen's error card, not crash a downstream .map or silently render an
// empty list over shops the user really has (the selectRules lesson).
import { describe, it, expect } from '@jest/globals';
import { selectUncategorizedMerchants } from '../queries';
import type { UncategorizedMerchants } from '../api';

describe('selectUncategorizedMerchants', () => {
  // Fail-on-revert: drop the Array.isArray guard and each of these renders "no shops" over real
  // data (or crashes the .map), instead of the screen's error card.
  it('throws (fails loud) on a malformed shape — not a silent empty list', () => {
    expect(() => selectUncategorizedMerchants({ merchants: [] } as unknown as UncategorizedMerchants)).toThrow(/groups/);
    expect(() => selectUncategorizedMerchants(null as unknown as UncategorizedMerchants)).toThrow(/groups/);
    expect(() => selectUncategorizedMerchants(undefined as unknown as UncategorizedMerchants)).toThrow(/groups/);
    expect(() => selectUncategorizedMerchants({ unfiled: 1, groups: 'nope' } as unknown as UncategorizedMerchants)).toThrow(/groups/);
  });
});
