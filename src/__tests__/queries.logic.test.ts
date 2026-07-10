// WHIT-188 — the pure pieces of the query layer: the cache keys and the select
// mappers that turn raw API payloads into client shapes. No React/RN, so these run
// in the fast logic project alongside the other selector tests.
import { describe, it, expect } from '@jest/globals';
import { selectBudgets, selectCategories, budgetsKey, breakdownKey, categoriesKey, payCycleKey } from '../queries';

describe('query keys', () => {
  it('budgetsKey is a flat, un-windowed key (WHIT-72: server derives the window)', () => {
    // Flattened so budgets fetches in parallel with the pay cycle (no waterfall) and a
    // cycle-length change refetches ONCE (the explicit invalidate), not twice (key shift
    // + invalidate). The server ignores the client length, so no window is lost.
    expect(budgetsKey).toEqual(['budgets']);
  });
  it('breakdownKey is a flat, un-windowed key (WHIT-72)', () => {
    expect(breakdownKey).toEqual(['breakdown']);
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
    expect(out[0]).toEqual({ id: 'coffee', name: 'Coffee', bucket: 'Lifestyle', icon: 'coffee', color: '#E8A87C', recent: 52, parent: null });
    expect(out[1].icon).toBe('coffee'); // guaranteed-present fallback glyph
    expect(out[1].recent).toBe(0); // default so budget math never sees undefined
    expect(typeof out[1].color).toBe('string'); // palette default
    expect(out[1].parent).toBeNull(); // absent parent normalised to null (top-level)
  });

  it('carries a category parent link through unchanged', () => {
    const out = selectCategories([
      { id: 'parking', name: 'Parking', bucket: 'Living', icon: 'car', color: '#8AB4F8', recent: 0, parent: 'transport' },
    ]);
    expect(out[0].parent).toBe('transport');
  });

  it('throws (fails loud) on a malformed non-array payload — not a silent empty list', () => {
    // WHIT-194: a wrapped/changed /categories shape must surface as the screen's error card
    // (and, on a first load, categoriesError) rather than a cryptic "raw.map is not a function"
    // or a confident "0 categories" over data the user actually has. Mirrors selectRules.
    expect(() => selectCategories({ categories: [] } as unknown as unknown[])).toThrow(/expected an array/);
    expect(() => selectCategories(null as unknown as unknown[])).toThrow(/expected an array/);
    expect(() => selectCategories(undefined as unknown as unknown[])).toThrow(/expected an array/);
  });
});
