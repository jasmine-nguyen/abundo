// WHIT-432 QA — [B1]-[B2] the adversarial half of "the fallback table mirrors the server": the slot
// branch of chartCategoryColor is still ALIVE (an equality pin passes with it deleted —
// demonstrated in review), and the guarantee the deleted collision inventory carried still holds.
import { describe, it, expect } from '@jest/globals';
import {
  ASSIGNMENT_ORDER, CATEGORY_COLORS, BUILTIN_CATEGORY_INDEX, chartCategoryColor,
} from '../chartColors';
import { readServerSeedSlots } from './serverSeedSlots';

const SERVER_SLOTS = readServerSeedSlots();

/** The first slot that resolves somewhere OTHER than `index` — always exists (20 positions, 1 taken). */
function foreignSlot(index: number): number {
  const slot = ASSIGNMENT_ORDER.findIndex((position) => position !== index);
  if (slot === -1) throw new Error(`no slot resolves off ramp position ${index}`);
  return slot;
}

describe('[B1] the slot branch is still alive for every built-in, not just coffee', () => {
  it('a built-in handed a slot it does NOT own paints the SLOT hue, never its fallback', () => {
    // The gap [A7] leaves open. `chartCategoryColor(id) === chartCategoryColor(id, {slot})` is
    // satisfied just as well by a chartCategoryColor that ignores `slot` entirely, and its sibling
    // assertion `BUILTIN_CATEGORY_INDEX[id] === ASSIGNMENT_ORDER[slot]` never calls the function at
    // all. chartColors.logic.test.ts covers exactly one id; this covers all 13. The foreign slot is
    // COMPUTED, so a future re-space cannot make it agree by accident and re-open the hole.
    for (const [id, index] of Object.entries(BUILTIN_CATEGORY_INDEX)) {
      const slot = foreignSlot(index);
      expect(chartCategoryColor(id, { slot })).toBe(CATEGORY_COLORS[ASSIGNMENT_ORDER[slot]]);
      expect(chartCategoryColor(id, { slot })).not.toBe(chartCategoryColor(id));
    }
    expect(Object.keys(BUILTIN_CATEGORY_INDEX)).toHaveLength(13);
  });
});

describe('[B2] a half-migrated store: the guarantee the deleted inventory used to carry', () => {
  it('no built-in reading its FALLBACK can share a hue with another built-in reading its SLOT', () => {
    // WHIT-432 deleted the ['transport->phonenet'] inventory on the grounds that an empty list
    // passes with slot resolution stubbed out. True — but the property itself is the user-visible
    // one (two slices, one colour, on a store where the backfill wrote and a later PATCH echoed a
    // pre-backfill row: shared/repository_category.py update_category returns the raw stored item).
    // Kept as an INVARIANT over the real .py, paired with [B1] so the stub hole is closed rather
    // than argued away.
    for (const unslotted of Object.keys(BUILTIN_CATEGORY_INDEX)) {
      for (const [slotted, slot] of Object.entries(SERVER_SLOTS)) {
        if (unslotted === slotted) continue;
        expect(chartCategoryColor(unslotted)).not.toBe(chartCategoryColor(slotted, { slot }));
      }
    }
    expect(Object.keys(SERVER_SLOTS)).toHaveLength(13);
  });
});
