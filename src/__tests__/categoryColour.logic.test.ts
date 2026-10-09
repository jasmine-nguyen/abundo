// toCategory's colour slot (WHIT-402). Which colour a category paints is pinned by
// categoryOnePalette.logic.test.ts (WHIT-836: one palette, src/chartColors.ts, on every screen).
import { describe, it, expect } from '@jest/globals';
import { toCategory } from '../model';
import { COFFEE_RECORD } from './support/categories';

// --- the persisted chart-colour slot (WHIT-402) ------------------------------
//
// toCategory is the ONLY place a Category is constructed in production, and it is the gate between
// the wire and the chart. It must let a valid slot through untouched (including 0) and reject
// anything unusable. Every category route coerces server-side now (WHIT-428 gave PATCH the same
// treatment GET already had), so this is boundary defence rather than a known-dirty source: a
// client running AHEAD of the server still meets the old uncleaned shape.

describe('toCategory — colorSlot', () => {
  const base = COFFEE_RECORD;

  it('carries a valid slot through, and treats 0 as valid', () => {
    expect(toCategory({ ...base, colorSlot: 4 }).colorSlot).toBe(4);
    expect(toCategory({ ...base, colorSlot: 19 }).colorSlot).toBe(19);
    // 0 is Eating Out's slot. `raw.colorSlot || undefined` would silently drop it.
    expect(toCategory({ ...base, colorSlot: 0 }).colorSlot).toBe(0);
  });

  it('leaves it undefined when the server sent none — NOT 0', () => {
    // `?? 0` here would paint an entire un-migrated taxonomy one pink, which reads as a rendering
    // bug; undefined instead routes each category to its id-derived colour, i.e. today's chart.
    expect(toCategory(base).colorSlot).toBeUndefined();
    expect(toCategory({ ...base, colorSlot: null }).colorSlot).toBeUndefined();
  });

  it('rejects uncoerced values, whatever sent them', () => {
    // A representative sample — normalizeColorSlot's own suite pins the exhaustive table. What
    // this test is for is proving toCategory actually CALLS the normaliser.
    for (const bad of ['7', 7.5, -5, 20]) {
      expect(toCategory({ ...base, colorSlot: bad }).colorSlot).toBeUndefined();
    }
  });
});
