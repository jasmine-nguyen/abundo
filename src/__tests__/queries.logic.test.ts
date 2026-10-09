// WHIT-188 — the pure pieces of the query layer: the cache keys and the select
// mappers that turn raw API payloads into client shapes. No React/RN, so these run
// in the fast logic project alongside the other selector tests.
import { describe, it, expect } from '@jest/globals';
import { selectBudgets, selectCategories } from '../queries';
import { budgetsKey, breakdownKey, categoriesKey, payCycleKey } from '../queryKeys';
import { GROCERIES_RECORD } from './support/categories';

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
      { id: 'coffee', budget: 100, posted: 40, pending: 10, rollover: false, carryover: 0, carryoverCycles: [], carryoverEarlier: 0, spreadAdjustment: 0, available: 100 },
      { id: 'food', budget: 250, posted: 60, pending: 5, rollover: false, carryover: 0, carryoverCycles: [], carryoverEarlier: 0, spreadAdjustment: 0, available: 250 },
    ]);
    expect(out.some((b) => b.id === 'rent')).toBe(false);
  });

  it('is empty for an empty rollup map', () => {
    expect(selectBudgets({})).toEqual([]);
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

  it('gives each built-in id its fixed ramp colour, spread across the wheel', () => {
    const out = selectCategories([
      { ...GROCERIES_RECORD, color: '#7FD49B' },
      { id: 'shopping', name: 'Shopping', bucket: 'Lifestyle', icon: 'bag', color: '#6FD0C9' },
      { id: 'fitness', name: 'Fitness', bucket: 'Lifestyle', icon: 'dumbbell', color: '#8FD46B' },
      { id: 'travel', name: 'Travel', bucket: 'Lifestyle', icon: 'plane', color: '#6FB6D0' },
    ]);
    // Each built-in id maps to its own ramp colour: green → teal → sky → cyan, no two alike.
    expect(out[0].color).toBe('#8ec56f'); // groceries → green
    expect(out[1].color).toBe('#25cdbd'); // shopping → teal
    expect(out[2].color).toBe('#47c1f5'); // fitness → sky
    expect(out[3].color).toBe('#0bcbd3'); // travel → cyan
  });

  it('gives a non-built-in id a deterministic colour, ignoring the server hex', () => {
    // A user-created category with no slot gets a ramp colour keyed off its id — stable across
    // reads and independent of whatever colour the server stored.
    const first = selectCategories([{ id: 'wine-club', name: 'Wine', bucket: 'Living', icon: 'cart', color: '#2ac3de' }]);
    const again = selectCategories([{ id: 'wine-club', name: 'Wine', bucket: 'Living', icon: 'cart', color: '#ffffff' }]);
    expect(first[0].color).not.toBe('#2ac3de');       // not the passed-in hex
    expect(first[0].color).toBe(again[0].color);       // same id → same colour regardless of hex
    expect(first[0].color).toMatch(/^#[0-9a-f]{6}$/);  // a real hex token
  });

  it('carries a category parent link through unchanged', () => {
    const out = selectCategories([
      { id: 'parking', name: 'Parking', bucket: 'Living', icon: 'car', color: '#8AB4F8', parent: 'transport' },
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

// WHIT-188 GAPS (authored by qa) — selector boundaries beyond the target:0 case above.
describe('selectBudgets boundaries', () => {
  it('drops a NEGATIVE target and keeps a tiny positive one', () => {
    const out = selectBudgets({
      neg: { target: -5, posted: 0, pending: 0 },
      tiny: { target: 0.01, posted: 0, pending: 0 },
    });
    expect(out.map((b) => b.id)).toEqual(['tiny']);
    expect(out[0]).toEqual({ id: 'tiny', budget: 0.01, posted: 0, pending: 0, rollover: false, carryover: 0, carryoverCycles: [], carryoverEarlier: 0, spreadAdjustment: 0, available: 0.01 });
  });
});

describe('selectCategories boundaries', () => {
  it('is empty for an empty list', () => {
    expect(selectCategories([])).toEqual([]);
  });
});
