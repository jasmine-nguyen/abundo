// The Insights chart palette (WHIT chart palette). Locks the two things that matter: the 13 built-in
// categories get 13 DISTINCT, fixed colours (the coffee/health/utilities collision a blind hash would
// create is gone), and a category's colour is a pure, stable function of its id (never reshuffles).
import { describe, it, expect } from '@jest/globals';
import { chartCategoryColor, normalizeColorSlot, ASSIGNMENT_ORDER, CATEGORY_COLORS, OTHER_COLOR, CHART_BG } from '../chartColors';

// The built-in category ids, mirroring the server seed (shared/repository_category.py).
const BUILTIN_IDS = [
  'coffee', 'groceries', 'eatingout', 'transport', 'health', 'pets', 'utilities',
  'shopping', 'fitness', 'subs', 'travel', 'gifts', 'phonenet',
];

describe('chartCategoryColor', () => {
  it('gives the 13 built-in categories 13 DISTINCT colours (no collision)', () => {
    const colours = BUILTIN_IDS.map((id) => chartCategoryColor(id));
    expect(new Set(colours).size).toBe(13);
  });

  it('assigns custom ids a real ramp colour, never the reserved "Other" grey', () => {
    for (const id of ['wine', 'brunch', 'hobbies', 'daycare', '__uncategorized__', null, undefined, '']) {
      const colour = chartCategoryColor(id);
      expect(CATEGORY_COLORS).toContain(colour);
      expect(colour).not.toBe(OTHER_COLOR);
    }
  });
});

// --- painting from the PERSISTED colorSlot (WHIT-402) ------------------------
//
// A category's colour is now its server-assigned slot resolved through ASSIGNMENT_ORDER; the
// id-derived colour above survives only as the fallback for a category with no slot yet.

describe('chartCategoryColor — the stored slot', () => {

  it('resolves every slot 0-19 to its ramp colour, all 20 distinct', () => {
    const colours = [...Array(20).keys()].map((slot) => chartCategoryColor('anything', { slot }));
    expect(new Set(colours).size).toBe(20);
    expect(colours[0]).toBe('#f98f98');    // anchor: slot 0
    expect(colours[19]).toBe('#e991cc');   // anchor: slot 19
    for (let slot = 0; slot < 20; slot++) {
      expect(colours[slot]).toBe(CATEGORY_COLORS[ASSIGNMENT_ORDER[slot]]);
    }
  });

  it('treats slot 0 as a REAL slot, not as absent', () => {
    // Eating Out is slot 0. A truthy check (`if (slot)`) would drop it to the id fallback.
    expect(chartCategoryColor('coffee', { slot: 0 })).toBe('#f98f98');
    expect(chartCategoryColor('coffee', { slot: 0 })).not.toBe(chartCategoryColor('coffee'));
  });

  it('lets a stored slot override the id entirely', () => {
    // Pin the hex, and pin that it DIFFERS from coffee's fallback. Comparing two ids against each
    // other is not enough: 'coffee' (built-in 3) and a hashed id can land on the same ramp entry,
    // so such an assertion holds even with the slot branch deleted.
    expect(chartCategoryColor('coffee', { slot: 10 })).toBe('#d2ae45');
    expect(chartCategoryColor('coffee', { slot: 10 })).not.toBe(chartCategoryColor('coffee'));
  });

  it('falls back to the id colour for any unusable slot — never an undefined wedge', () => {
    // Each of these would index ASSIGNMENT_ORDER out of range and yield `undefined`, which reaches
    // a `backgroundColor` style as an INVISIBLE slice. JS `%` keeps the sign, so a negative cannot
    // be rescued by wrapping: -5 % 20 is -5.
    // Non-number shapes ('7', true, {}, ...) are rejected by the type system now and are pinned
    // exhaustively in the normalizeColorSlot suite below; here we cover the numeric ones that
    // actually reach this function at runtime.
    const unusable = [-1, -5, 0.5, 7.5, NaN, Infinity, -Infinity, 20, 999, undefined];
    for (const slot of unusable) {
      const colour = chartCategoryColor('coffee', { slot });
      expect(colour).toBe(chartCategoryColor('coffee'));   // fell back
      expect(CATEGORY_COLORS).toContain(colour);           // always a real ramp colour
      expect(colour).not.toBe(OTHER_COLOR);                // never the reserved grey
    }
  });
});

describe('normalizeColorSlot', () => {
  it('accepts the whole legal range and nothing else', () => {
    expect(normalizeColorSlot(0)).toBe(0);        // slot 0 is valid, not falsy-absent
    expect(normalizeColorSlot(19)).toBe(19);
    expect(normalizeColorSlot(4.0)).toBe(4);      // PATCH encodes Decimal as 4.0; JS sees 4
    for (const bad of [-1, 20, 999, 7.5, NaN, Infinity, '4', true, null, undefined, {}]) {
      expect(normalizeColorSlot(bad)).toBeUndefined();
    }
  });
});

// WHIT-403 — the slice divider is the CHART_BG ring track showing THROUGH the gap between wedges,
// so CHART_BG is a colour no slice may ever be.
describe('the divider colour can never also be a slice colour', () => {
  // [Q14] REGRESSION GUARD over the whole reachable range of slice colours: every ramp entry, the
  // reserved "Other" grey, and each of the three ways chartCategoryColor resolves one (stored slot,
  // built-in id, hashed unknown id, blank id). A future ramp tweak that lands on #16161e would
  // silently delete that category from the chart.
  it('[Q14] no colour a wedge can be painted equals CHART_BG', () => {
    expect(CATEGORY_COLORS).not.toContain(CHART_BG);
    expect(OTHER_COLOR).not.toBe(CHART_BG);

    const reachable = [
      ...ASSIGNMENT_ORDER.map((_, slot) => chartCategoryColor('anything', { slot })),
      chartCategoryColor('coffee'),               // built-in id path
      chartCategoryColor('a-user-made-category'), // hashed unknown id path
      chartCategoryColor(null),                   // no id at all
    ];
    expect(reachable).not.toContain(CHART_BG);
  });
});
