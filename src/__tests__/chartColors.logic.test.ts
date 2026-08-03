// The Insights chart palette (WHIT chart palette). Locks the two things that matter: the 13 built-in
// categories get 13 DISTINCT, fixed colours (the coffee/health/utilities collision a blind hash would
// create is gone), and a category's colour is a pure, stable function of its id (never reshuffles).
import { describe, it, expect } from '@jest/globals';
import { chartCategoryColor, normalizeColorSlot, ASSIGNMENT_ORDER, CATEGORY_COLORS, OTHER_COLOR, BUILTIN_CATEGORY_INDEX } from '../chartColors';

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

  it('never puts the reserved "Other" grey in the category ramp', () => {
    // WHIT-403: a strictly weaker stand-in for a deleted check. The old one proved no ramp colour was
    // dull enough to be MISTAKEN for the reserved grey; the classifier that made that measurable went
    // with the donut's warm/cool shuffle. This only catches an exact duplicate, not a drift toward grey.
    expect(CATEGORY_COLORS).not.toContain(OTHER_COLOR);
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
    const wineAmongMany = ['aardvark', 'wine', 'zebra', 'coffee'].map((id) => chartCategoryColor(id))[1];
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
    expect(new Set(ids.map((id) => chartCategoryColor(id))).size).toBeGreaterThan(1);
  });

  it('falls back to the first ramp colour for a null/blank id', () => {
    expect(chartCategoryColor(null)).toBe(CATEGORY_COLORS[0]);
    expect(chartCategoryColor(undefined)).toBe(CATEGORY_COLORS[0]);
    expect(chartCategoryColor('')).toBe(CATEGORY_COLORS[0]);
  });
});

// --- painting from the PERSISTED colorSlot (WHIT-402) ------------------------
//
// A category's colour is now its server-assigned slot resolved through ASSIGNMENT_ORDER; the
// id-derived colour above survives only as the fallback for a category with no slot yet.

// The server's seed slots (shared/repository_category.py SEED_CATEGORIES), and the hex each one
// resolves to. Hard-coded rather than computed, so a regenerated ASSIGNMENT_ORDER fails loudly.
const SEED_SLOT_HEX: Record<string, [number, string]> = {
  eatingout: [0, '#f98f98'], travel: [1, '#0bcbd3'], fitness: [6, '#47c1f5'],
  gifts: [7, '#bf9ff8'], health: [8, '#f9927e'], coffee: [9, '#e8a24f'],
  utilities: [10, '#d2ae45'], groceries: [11, '#8ec56f'], shopping: [13, '#25cdbd'],
  transport: [15, '#65baff'], phonenet: [16, '#82b4ff'], pets: [17, '#aba7ff'],
  subs: [18, '#d797e6'],
};

describe('chartCategoryColor — the stored slot', () => {
  it('ASSIGNMENT_ORDER is a true permutation of the ramp, so no colour repeats or is lost', () => {
    expect(ASSIGNMENT_ORDER.length).toBe(CATEGORY_COLORS.length);
    expect([...ASSIGNMENT_ORDER].sort((a, b) => a - b))
      .toEqual([...Array(CATEGORY_COLORS.length).keys()]);
  });

  it('resolves every slot 0-19 to its ramp colour, all 20 distinct', () => {
    const colours = [...Array(20).keys()].map((slot) => chartCategoryColor('anything', { slot }));
    expect(new Set(colours).size).toBe(20);
    expect(colours[0]).toBe('#f98f98');    // anchor: slot 0
    expect(colours[19]).toBe('#e991cc');   // anchor: slot 19
    for (let slot = 0; slot < 20; slot++) {
      expect(colours[slot]).toBe(CATEGORY_COLORS[ASSIGNMENT_ORDER[slot]]);
    }
  });

  it('gives each built-in the colour its server slot resolves to', () => {
    for (const [id, [slot, hex]] of Object.entries(SEED_SLOT_HEX)) {
      expect(chartCategoryColor(id, { slot })).toBe(hex);
    }
    // The built-ins that move off their id-derived colour, and the rest that do not. WHIT-415 took
    // coffee OUT of this set: its slot now resolves to the same ramp entry as its fallback, so the
    // set shrank from four to three.
    const moved = Object.entries(SEED_SLOT_HEX)
      .filter(([id, [slot]]) => chartCategoryColor(id, { slot }) !== chartCategoryColor(id))
      .map(([id]) => id);
    expect(moved.sort()).toEqual(['phonenet', 'shopping', 'transport']);
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

  it('falls back for a category with no slot at all — exactly today\'s colours', () => {
    for (const id of BUILTIN_IDS) {
      expect(chartCategoryColor(id, {})).toBe(chartCategoryColor(id));
      expect(chartCategoryColor(id, { slot: undefined })).toBe(chartCategoryColor(id));
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
