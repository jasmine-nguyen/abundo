// The Insights chart palette (WHIT chart palette). Locks the two things that matter: the 13 built-in
// categories get 13 DISTINCT, fixed colours (the coffee/health/utilities collision a blind hash would
// create is gone), and a category's colour is a pure, stable function of its id (never reshuffles).
import { describe, it, expect } from '@jest/globals';
import { chartCategoryColor, CATEGORY_COLORS, OTHER_COLOR, BUILTIN_CATEGORY_INDEX } from '../theme/chartColors';

// The built-in category ids, mirroring the server seed (shared/repository_category.py).
const BUILTIN_IDS = [
  'coffee', 'groceries', 'eatingout', 'transport', 'health', 'pets', 'utilities',
  'shopping', 'fitness', 'subs', 'travel', 'gifts', 'phonenet',
];

describe('chartCategoryColor', () => {
  it('gives the 13 built-in categories 13 DISTINCT colours (no collision)', () => {
    const colours = BUILTIN_IDS.map(chartCategoryColor);
    expect(new Set(colours).size).toBe(13);
  });

  it('keeps coffee, health and utilities on different colours (the collision the review caught)', () => {
    const coffee = chartCategoryColor('coffee');
    const health = chartCategoryColor('health');
    const utilities = chartCategoryColor('utilities');
    expect(new Set([coffee, health, utilities]).size).toBe(3);
    // FAIL-ON-REVERT: hashing these ids (djb2 % 20) instead of the explicit map lands all three on
    // one slot → the Set collapses to size 1.
  });

  it('maps each built-in id to its fixed ramp slot', () => {
    expect(chartCategoryColor('eatingout')).toBe('#f98f98'); // slot 0
    expect(chartCategoryColor('coffee')).toBe('#e8a24f');    // slot 3
    expect(chartCategoryColor('groceries')).toBe('#8ec56f'); // slot 6
    expect(chartCategoryColor('transport')).toBe('#82b4ff'); // slot 14
    expect(chartCategoryColor('subs')).toBe('#d797e6');      // slot 18
    // every built-in resolves to CATEGORY_COLORS[its mapped index]
    for (const id of BUILTIN_IDS) {
      expect(chartCategoryColor(id)).toBe(CATEGORY_COLORS[BUILTIN_CATEGORY_INDEX[id]]);
    }
  });

  it('has a built-in map whose keys are exactly the 13 seed ids, with distinct in-range indices', () => {
    expect(new Set(Object.keys(BUILTIN_CATEGORY_INDEX))).toEqual(new Set(BUILTIN_IDS));
    const indices = Object.values(BUILTIN_CATEGORY_INDEX);
    expect(new Set(indices).size).toBe(13);                             // distinct
    for (const i of indices) expect(i).toBeGreaterThanOrEqual(0);
    for (const i of indices) expect(i).toBeLessThan(CATEGORY_COLORS.length);
  });

  it('is stable — the same id always returns the same colour', () => {
    for (const id of ['coffee', 'wine', 'brunch', '__uncategorized__']) {
      expect(chartCategoryColor(id)).toBe(chartCategoryColor(id));
    }
  });

  it('is a pure function of the id — a custom colour never depends on other categories', () => {
    // "a category keeps its colour": the colour is derived from the id alone, so adding or removing
    // other categories can never shift it (unlike an alphabetical-index scheme).
    const wineAlone = chartCategoryColor('wine');
    const wineAmongMany = ['aardvark', 'wine', 'zebra', 'coffee'].map(chartCategoryColor)[1];
    expect(wineAmongMany).toBe(wineAlone);
  });

  it('assigns custom ids a real ramp colour, never the reserved "Other" grey', () => {
    for (const id of ['wine', 'brunch', 'hobbies', 'daycare', '__uncategorized__']) {
      const colour = chartCategoryColor(id);
      expect(CATEGORY_COLORS).toContain(colour);
      expect(colour).not.toBe(OTHER_COLOR);
    }
  });

  it('spreads many custom ids across more than one colour', () => {
    const ids = Array.from({ length: 40 }, (_, i) => `custom-${i}`);
    expect(new Set(ids.map(chartCategoryColor)).size).toBeGreaterThan(1);
  });

  it('falls back to the first ramp colour for a null/blank id', () => {
    expect(chartCategoryColor(null)).toBe(CATEGORY_COLORS[0]);
    expect(chartCategoryColor(undefined)).toBe(CATEGORY_COLORS[0]);
    expect(chartCategoryColor('')).toBe(CATEGORY_COLORS[0]);
  });
});
