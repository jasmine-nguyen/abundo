// WHIT-415 — [A1]-[A7] the CROSS-LANGUAGE guard the change shipped without.
//
// The card moved two slots in shared/repository_category.py. Every client test that "mirrors the
// server seed" is a hand copy, so all of them stayed green against the OLD table until someone
// remembered to retype them — the drift WHIT-406 tracks. This file removes the mirror: it parses
// the real .py and asserts the CLIENT's resolution of it. Change the Python seed without thinking
// and these redden.
import { describe, it, expect } from '@jest/globals';
import {
  ASSIGNMENT_ORDER, CATEGORY_COLORS, BUILTIN_CATEGORY_INDEX, OTHER_COLOR,
  chartCategoryColor, normalizeColorSlot,
} from '../chartColors';
import { readServerSeedSlots, readServerSlotCount, neighbouringRuns } from './serverSeedSlots';

const SERVER_SLOTS = readServerSeedSlots();
/** {id -> the RAMP POSITION the client resolves that server slot to}. */
const SERVER_RAMP = Object.fromEntries(
  Object.entries(SERVER_SLOTS).map(([id, slot]) => [id, ASSIGNMENT_ORDER[slot]]),
) as Record<string, number>;

describe('[A1] the two languages agree on the vocabulary and the slot range', () => {
  it('parses all 13 built-ins, and they are exactly the ids the client fallback knows', () => {
    expect(Object.keys(SERVER_SLOTS).sort()).toEqual(Object.keys(BUILTIN_CATEGORY_INDEX).sort());
    expect(Object.keys(SERVER_SLOTS)).toHaveLength(13);
  });

  it('[A2] the server hands out exactly as many slots as the ramp permutation can resolve', () => {
    // chartColors.ts says these "must stay in step, neither of which a Jest run can see".
    // It can now. A server that assigned slot 20 would index ASSIGNMENT_ORDER off the end and
    // paint an INVISIBLE wedge (undefined -> stroke), which is why this is the load-bearing one.
    expect(readServerSlotCount()).toBe(ASSIGNMENT_ORDER.length);
    expect([...ASSIGNMENT_ORDER].sort((a, b) => a - b))
      .toEqual([...Array(readServerSlotCount()).keys()]);
  });

  it('[A3] every slot the server actually seeds survives the client boundary guard', () => {
    for (const [id, slot] of Object.entries(SERVER_SLOTS)) {
      expect(normalizeColorSlot(slot)).toBe(slot);
      const colour = chartCategoryColor(id, { slot });
      expect(CATEGORY_COLORS).toContain(colour);
      expect(colour).not.toBe(OTHER_COLOR);   // never the reserved "Other" grey
    }
  });
});

describe('[A4] the seeded store paints 13 distinct, well-spaced colours', () => {
  it('gives every built-in its own hex', () => {
    const painted = Object.entries(SERVER_SLOTS).map(([id, slot]) => chartCategoryColor(id, { slot }));
    expect(new Set(painted).size).toBe(13);
  });

  it('[A5] Eating Out / Health / Coffee are NOT three neighbouring hues — the card', () => {
    // The reported bug: as the top three by spend they painted as three near-identical salmons.
    // Expressed as the PROPERTY, computed from the .py — not as "coffee's slot is 9", which a
    // future re-shuffle would just retype.
    const warmTrio = ['eatingout', 'health', 'coffee'].map((id) => SERVER_RAMP[id]).sort((a, b) => a - b);
    expect(warmTrio[2] - warmTrio[0]).toBeGreaterThan(2);
    // and nothing else may creep into the salmon end (ramp 0-2) to re-form a trio
    const salmonEnd = Object.entries(SERVER_RAMP).filter(([, p]) => p <= 2).map(([id]) => id);
    expect(salmonEnd.sort()).toEqual(['eatingout', 'health']);
  });

  it('[A6] the runs of neighbouring built-ins are exactly these — pinned, not measured', () => {
    // `longest run == 3` (the existing pytest) was true BEFORE this card and is true AFTER, so it
    // never checked the fix. This pins WHICH ids touch. It also records, honestly, that TWO trios
    // SURVIVE the re-space — fitness/transport/phonenet and pets/gifts/subs — and those sit on the
    // ramp's TIGHTEST steps. Re-space again and you must edit this list on purpose.
    expect(neighbouringRuns(SERVER_RAMP)).toEqual([
      ['eatingout', 'health'],
      ['coffee', 'utilities'],
      ['shopping', 'travel'],
      ['fitness', 'transport', 'phonenet'],
      ['pets', 'gifts', 'subs'],
    ]);
  });
});

describe('[A7] a half-migrated store paints every built-in ONE hue, either way', () => {
  // WHIT-432 replaced a collision inventory that could only ever be empty once the tables agree.
  // The pin below reddens the moment they drift, in EITHER direction — which the inventory did not.
  // It does NOT prove the resolver exists: both assertions are satisfied by a chartCategoryColor
  // that ignores `slot` entirely, and the second never calls it at all. builtinFallbackMirror
  // [B1] covers that, and the custom-category test below is the only thing here that does.
  it('every built-in resolves to the same colour whether or not its slot has arrived', () => {
    for (const [id, slot] of Object.entries(SERVER_SLOTS)) {
      expect(chartCategoryColor(id)).toBe(chartCategoryColor(id, { slot }));
      expect(BUILTIN_CATEGORY_INDEX[id]).toBe(ASSIGNMENT_ORDER[slot]);
    }
    // Non-vacuity: readServerSeedSlots throws on an empty parse, but a partially-matching regex
    // would leave a short map and make the loop above prove almost nothing.
    expect(Object.keys(SERVER_SLOTS)).toHaveLength(13);
  });

  it('a CUSTOM category can differ across the two paths — the pin is built-ins only', () => {
    // Not an oversight: the server hands out the least-held slot while the client hashes the id.
    // Unrelated by construction, so a custom category CAN change hue once its slot arrives — it
    // coincides roughly 1 time in 20. Pinned so nobody reads the built-in guarantee above as
    // applying to every category.
    expect(chartCategoryColor('wine', { slot: 3 })).not.toBe(chartCategoryColor('wine'));
  });
});
