// WHIT-188 GAPS (authored by qa) — selector boundaries beyond the implementer's
// target:0 case: a negative target is dropped, a tiny positive kept, empty list → [].
import { describe, it, expect } from '@jest/globals';
import { selectBudgets, selectCategories } from '../queries';

describe('selectBudgets boundaries', () => {
  it('drops a NEGATIVE target and keeps a tiny positive one', () => {
    const out = selectBudgets({
      neg: { target: -5, posted: 0, pending: 0 },
      tiny: { target: 0.01, posted: 0, pending: 0 },
    });
    expect(out.map((b) => b.id)).toEqual(['tiny']);
    expect(out[0]).toEqual({ id: 'tiny', budget: 0.01, posted: 0, pending: 0 });
  });
});

describe('selectCategories boundaries', () => {
  it('is empty for an empty list', () => {
    expect(selectCategories([])).toEqual([]);
  });
});
