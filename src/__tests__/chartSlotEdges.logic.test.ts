// WHIT-402 — [A15] [A16] the stored-slot colour resolution: the toCategory -> chartCategoryColor
// hand-off (nothing pins that the value one produces is usable by the other), and the
// mixed-state colours a partially-slotted store can show.
import { describe, it, expect } from '@jest/globals';
import { chartCategoryColor, ASSIGNMENT_ORDER, CATEGORY_COLORS, OTHER_COLOR } from '../chartColors';
import { toCategory } from '../model';
import { readServerSeedSlots } from './serverSeedSlots';
import { COFFEE_RECORD } from './support/categories';

// The server's seed slots, READ from shared/repository_category.py — not retyped. A hand copy
// going stale is the whole reason WHIT-406/415/432 exist.
const SEED_SLOTS = readServerSeedSlots();

describe('[A15] toCategory hands chartCategoryColor a value it can actually use', () => {
  it('round-trips every legal slot from the wire to the painted hex', () => {
    // The two halves are tested separately today; nothing pins the JOIN. A one-off in either (a
    // stringified slot, an off-by-one range) would leave both suites green and the chart wrong.
    const base = COFFEE_RECORD;
    for (let slot = 0; slot < CATEGORY_COLORS.length; slot++) {
      const stored = toCategory({ ...base, colorSlot: slot }).colorSlot;
      expect(chartCategoryColor('coffee', { slot: stored })).toBe(CATEGORY_COLORS[ASSIGNMENT_ORDER[slot]]);
    }
  });

  it('a rejected wire value round-trips to EXACTLY the id-derived colour', () => {
    const base = { id: 'transport', name: 'Transport', bucket: 'Living', icon: 'car' };
    for (const bad of ['15', 15.5, -15, true, 20, 999, {}, null, undefined]) {
      const stored = toCategory({ ...base, colorSlot: bad }).colorSlot;
      expect(stored).toBeUndefined();
      expect(chartCategoryColor('transport', { slot: stored })).toBe(chartCategoryColor('transport'));
    }
  });
});

describe('[A16] a partially-slotted store cannot show two BUILT-INS one colour', () => {
  // A store can be mixed while the server's slot migration is still draining: a cached list fetched
  // before a chunk landed sits alongside rows fetched after it, so two categories resolve down
  // different paths.
  //
  // WHIT-432 removed the collision inventory that used to sit here (it asserted the clashes equalled
  // ['transport->phonenet']). Once the fallback mirrors the server that list can only be empty.
  // The pair below is stronger where it matters — it fails on table drift, which the inventory did
  // not. Neither proves the resolver exists; builtinFallbackMirror [B1] and [A15] do.
  // Built-ins only: a hashed CUSTOM id can still land on a built-in's fallback hue.

  it('a FULLY slotted store gives all 13 built-ins 13 distinct colours', () => {
    const painted = Object.entries(SEED_SLOTS).map(([id, slot]) => chartCategoryColor(id, { slot }));
    expect(new Set(painted).size).toBe(13);
    expect(painted).not.toContain(OTHER_COLOR);
  });

  it('an un-slotted store paints the SAME 13 colours a slotted one does', () => {
    // Compared against the SLOTTED chart, not against BUILTIN_CATEGORY_INDEX — the old version did
    // the latter, which is the implementation restated. Distinct + equal ⇒ no mixed-state pair of
    // BUILT-INS can share a hue, which is what [A16] is for.
    for (const [id, slot] of Object.entries(SEED_SLOTS)) {
      expect(chartCategoryColor(id, { slot: undefined })).toBe(chartCategoryColor(id, { slot }));
    }
    expect(Object.keys(SEED_SLOTS)).toHaveLength(13);
  });
});

