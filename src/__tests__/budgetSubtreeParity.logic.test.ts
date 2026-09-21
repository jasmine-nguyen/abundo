// WHIT-348 parity: the client budgetSubtreeContains must mirror the server's subtree_ids
// (shared/spend.py). Both this test and tests/shared/test_subtree_parity.py load the SAME
// committed fixture (tests/fixtures/subtree_parity.json) and assert their rule reproduces every
// case in the full budgetId x categoryId cross-product, so accidental drift on either side reddens.
// This half pins the CLIENT rule to the frozen truth table. `require` (not import) sidesteps a
// tsc JSON-path check across the src/ boundary, mirroring the existing tests' require() usage.
import { describe, it, expect } from '@jest/globals';
import { budgetSubtreeContains } from '../context';
import type { Category } from '../context';

const fixture = require('../../tests/fixtures/subtree_parity.json') as {
  categories: { id: string; parent: string | null; bucket: string | null }[];
  cases: { budgetId: string; categoryId: string; expected: boolean }[];
};
const categories = fixture.categories as unknown as Category[];

describe('budgetSubtreeContains — parity with server subtree_ids (WHIT-348)', () => {
  it('reproduces every case in the shared full cross-product fixture', () => {
    for (const { budgetId, categoryId, expected } of fixture.cases) {
      expect(budgetSubtreeContains(categories, budgetId, categoryId)).toBe(expected);
    }
  });

  it('the fixture actually covers the drift-prone shapes', () => {
    // If the taxonomy is ever trimmed, the parity above weakens silently — pin the shapes.
    const at = (b: string, c: string) =>
      fixture.cases.find((x) => x.budgetId === b && x.categoryId === c)?.expected;
    const ids = new Set(fixture.categories.map((c) => c.id));
    expect(fixture.cases.length).toBe(ids.size * ids.size);       // full cross-product
    expect(at('living_root', 'deep_living')).toBe(true);          // same-bucket leaf under a cross-bucket intermediate
    expect(at('living_root', 'cross')).toBe(false);               // cross-bucket direct child dropped
    expect(at('none_root', 'none_kid')).toBe(true);               // None under None kept
    expect(at('none_root', 'none_kid_living')).toBe(false);       // Living under None dropped
    expect(at('cyc_a', 'cyc_b')).toBe(true);                      // two-node cycle terminates & agrees
  });
});
