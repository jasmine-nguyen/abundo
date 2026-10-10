// WHIT-188 — the pure select mappers that turn raw API payloads into client shapes.
// No React/RN, so these run in the fast logic project alongside the other selector tests.
import { describe, it, expect } from '@jest/globals';
import { selectBudgets, selectCategories } from '../queries';

describe('selectBudgets', () => {
  it('maps rollups to Budgets, drops zero and negative targets, keeps a tiny positive one (never divide by 0)', () => {
    const out = selectBudgets({
      coffee: { target: 100, posted: 40, pending: 10 },
      rent: { target: 0, posted: 0, pending: 0 }, // filtered out
      food: { target: 250, posted: 60, pending: 5 },
      neg: { target: -5, posted: 0, pending: 0 }, // filtered out
      tiny: { target: 0.01, posted: 0, pending: 0 },
    });
    expect(out).toEqual([
      { id: 'coffee', budget: 100, posted: 40, pending: 10, rollover: false, carryover: 0, carryoverCycles: [], carryoverEarlier: 0, spreadAdjustment: 0, available: 100 },
      { id: 'food', budget: 250, posted: 60, pending: 5, rollover: false, carryover: 0, carryoverCycles: [], carryoverEarlier: 0, spreadAdjustment: 0, available: 250 },
      { id: 'tiny', budget: 0.01, posted: 0, pending: 0, rollover: false, carryover: 0, carryoverCycles: [], carryoverEarlier: 0, spreadAdjustment: 0, available: 0.01 },
    ]);
  });
});

describe('selectCategories', () => {
  it('maps raw categories and defaults a missing icon; colour comes from the id', () => {
    const out = selectCategories([
      { id: 'coffee', name: 'Coffee', bucket: 'Lifestyle', icon: 'coffee', color: '#E8A87C' },
      { id: 'x', name: 'X', bucket: 'Living' }, // missing icon/color
    ]);
    // WHIT-836: the display colour is the Insights palette's, not the server hex — coffee's built-in
    // ramp colour is #e8a24f (the server's legacy '#E8A87C' is ignored).
    expect(out[0]).toEqual({ id: 'coffee', name: 'Coffee', bucket: 'Lifestyle', icon: 'coffee', color: '#e8a24f', parent: null });
    expect(out[1].icon).toBe('coffee'); // guaranteed-present fallback glyph
    expect(out[1]).not.toHaveProperty('recent');
    expect(typeof out[1].color).toBe('string'); // id-derived ramp colour
    expect(out[1].parent).toBeNull(); // absent parent normalised to null (top-level)
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
