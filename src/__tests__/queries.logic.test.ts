// WHIT-188 — the pure pieces of the query layer: the cache keys and the select
// mappers that turn raw API payloads into client shapes. No React/RN, so these run
// in the fast logic project alongside the other selector tests.
import { describe, it, expect } from '@jest/globals';
import { selectBudgets, selectCategories, budgetsKey, categoriesKey, payCycleKey } from '../queries';

describe('query keys', () => {
  it('budgetsKey includes the cycle length so a window change refetches', () => {
    expect(budgetsKey(14)).toEqual(['budgets', 14]);
    expect(budgetsKey(30)).toEqual(['budgets', 30]);
    expect(budgetsKey(14)).not.toEqual(budgetsKey(30)); // different windows → different cache entries
  });
  it('the static keys are stable', () => {
    expect(categoriesKey).toEqual(['categories']);
    expect(payCycleKey).toEqual(['payCycle']);
  });
});

describe('selectBudgets', () => {
  it('maps rollups to Budgets and drops non-positive targets (never divide by 0)', () => {
    const out = selectBudgets({
      coffee: { target: 100, posted: 40, pending: 10 },
      rent: { target: 0, posted: 0, pending: 0 }, // filtered out
      food: { target: 250, posted: 60, pending: 5 },
    });
    expect(out).toEqual([
      { id: 'coffee', budget: 100, posted: 40, pending: 10 },
      { id: 'food', budget: 250, posted: 60, pending: 5 },
    ]);
    expect(out.some((b) => b.id === 'rent')).toBe(false);
  });

  it('is empty for an empty rollup map', () => {
    expect(selectBudgets({})).toEqual([]);
  });
});

describe('selectCategories', () => {
  it('maps raw categories and defaults a missing icon/color/recent', () => {
    const out = selectCategories([
      { id: 'coffee', name: 'Coffee', bucket: 'Lifestyle', icon: 'coffee', color: '#E8A87C', recent: 52 },
      { id: 'x', name: 'X', bucket: 'Living' }, // missing icon/color/recent
    ]);
    expect(out[0]).toEqual({ id: 'coffee', name: 'Coffee', bucket: 'Lifestyle', icon: 'coffee', color: '#E8A87C', recent: 52 });
    expect(out[1].icon).toBe('coffee'); // guaranteed-present fallback glyph
    expect(out[1].recent).toBe(0); // default so budget math never sees undefined
    expect(typeof out[1].color).toBe('string'); // palette default
  });
});
