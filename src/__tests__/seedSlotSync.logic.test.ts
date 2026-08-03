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
      ['utilities', 'groceries'],
      ['shopping', 'travel'],
      ['fitness', 'transport', 'phonenet'],
      ['pets', 'gifts', 'subs'],
    ]);
  });
});

describe('[A7] a half-migrated store still has exactly one ambiguous pair', () => {
  it('adds no new slotted-vs-unslotted collision', () => {
    // A store can be mixed (PATCH echoes a pre-backfill row uncleaned), so one category resolves
    // via its slot and another via the id fallback. Moving a seed slot can silently land a
    // built-in ON another built-in's fallback hue. Computed from the .py, so it re-checks itself.
    const collisions: string[] = [];
    for (const unslotted of Object.keys(BUILTIN_CATEGORY_INDEX)) {
      for (const [slotted, slot] of Object.entries(SERVER_SLOTS)) {
        if (unslotted === slotted) continue;
        if (chartCategoryColor(unslotted) === chartCategoryColor(slotted, { slot })) {
          collisions.push(`${unslotted}->${slotted}`);
        }
      }
    }
    expect(collisions.sort()).toEqual(['transport->phonenet']);
  });

  it('coffee now paints the SAME hue whether or not the store has been backfilled', () => {
    // A side effect of the move worth locking: coffee's seeded slot resolves to ramp 3, which is
    // also its id-derived fallback, so a mid-migration store cannot show coffee two colours.
    // (Utilities took over the opposite role — see chartColors.logic.test.ts's `moved` list.)
    expect(chartCategoryColor('coffee', { slot: SERVER_SLOTS.coffee })).toBe(chartCategoryColor('coffee'));
    expect(chartCategoryColor('utilities', { slot: SERVER_SLOTS.utilities }))
      .not.toBe(chartCategoryColor('utilities'));
  });
});
