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
  it('maps raw categories and defaults a missing icon/recent; colour comes from the id', () => {
    const out = selectCategories([
      { id: 'coffee', name: 'Coffee', bucket: 'Lifestyle', icon: 'coffee', color: '#E8A87C', recent: 52 },
      { id: 'x', name: 'X', bucket: 'Living' }, // missing icon/color/recent
    ]);
    // WHIT-320: the display colour is a function of the id, not the server hex — coffee's built-in
    // base is #ff9e64 (the server's legacy '#E8A87C' is ignored).
    expect(out[0]).toEqual({ id: 'coffee', name: 'Coffee', bucket: 'Lifestyle', icon: 'coffee', color: '#ff9e64', recent: 52, parent: null });
    expect(out[1].icon).toBe('coffee'); // guaranteed-present fallback glyph
    expect(out[1].recent).toBe(0); // default so budget math never sees undefined
    expect(typeof out[1].color).toBe('string'); // id-derived sibling colour
    expect(out[1].parent).toBeNull(); // absent parent normalised to null (top-level)
  });

  it('gives each built-in id its fixed Tokyo Night hue, spread across the wheel', () => {
    const out = selectCategories([
      { id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#7FD49B', recent: 0 },
      { id: 'shopping', name: 'Shopping', bucket: 'Lifestyle', icon: 'bag', color: '#6FD0C9', recent: 0 },
      { id: 'fitness', name: 'Fitness', bucket: 'Lifestyle', icon: 'dumbbell', color: '#8FD46B', recent: 0 },
      { id: 'travel', name: 'Travel', bucket: 'Lifestyle', icon: 'plane', color: '#6FB6D0', recent: 0 },
    ]);
    // Each built-in id maps to its own base hue: green → teal → sky → cyan, no two alike.
    expect(out[0].color).toBe('#9ece6a'); // groceries → green
    expect(out[1].color).toBe('#73daca'); // shopping → teal
    expect(out[2].color).toBe('#7dcfff'); // fitness → sky
    expect(out[3].color).toBe('#2ac3de'); // travel → cyan
  });

  it('gives a non-built-in id a deterministic sibling colour, ignoring the server hex', () => {
    // WHIT-320: a user-created category isn't in CATEGORY_BASE, so it gets a darker sibling keyed
    // off its id — stable across reads and independent of whatever colour the server stored.
    const first = selectCategories([{ id: 'wine-club', name: 'Wine', bucket: 'Living', icon: 'cart', color: '#2ac3de', recent: 0 }]);
    const again = selectCategories([{ id: 'wine-club', name: 'Wine', bucket: 'Living', icon: 'cart', color: '#ffffff', recent: 0 }]);
    expect(first[0].color).not.toBe('#2ac3de');       // not the passed-in hex
    expect(first[0].color).toBe(again[0].color);       // same id → same colour regardless of hex
    expect(first[0].color).toMatch(/^#[0-9a-f]{6}$/);  // a real hex token
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
