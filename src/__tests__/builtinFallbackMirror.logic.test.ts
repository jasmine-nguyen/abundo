// WHIT-432 QA — [B1]-[B4] the adversarial half of "the fallback table mirrors the server".
//
// The mirror pin in seedSlotSync.logic.test.ts [A7] proves the two TABLES are equal. These prove the
// three things that pin cannot: that the slot branch of chartCategoryColor is still ALIVE (an
// equality pin passes with it deleted — demonstrated in review), that the guarantee the deleted
// collision inventory carried still holds, and that the two screen suites' exemplar slot still
// disagrees with shopping's fallback, which is what stops them going tautological after a re-space.
import fs from 'fs';
import path from 'path';
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

describe('[B3] the three ids WHIT-432 moved', () => {
  it('none of them still paints its pre-WHIT-432 hue', () => {
    // The card's three numbers, one assertion each, independent of the table-equality pin: revert
    // any single entry in BUILTIN_CATEGORY_INDEX and exactly that id reddens here.
    const before: Record<string, number> = { shopping: 8, transport: 14, phonenet: 15 };
    for (const [id, oldIndex] of Object.entries(before)) {
      // non-vacuity: the old hue must still BE a colour, or "no longer paints it" is free
      expect(CATEGORY_COLORS[oldIndex]).toMatch(/^#[0-9a-f]{6}$/);
      expect(chartCategoryColor(id)).not.toBe(CATEGORY_COLORS[oldIndex]);
      expect(chartCategoryColor(id)).toBe(chartCategoryColor(id, { slot: SERVER_SLOTS[id] }));
    }
  });

  it('the mirror is BUILT-INS only — a custom id can still land on a built-in hue', () => {
    // The honest limit chartColors.ts claims in prose, measured. 13 of the 20 ramp entries are
    // spoken for by a built-in fallback, so a hashed custom id can match one. Moving shopping 8->9
    // changed WHICH ids collide, not how many can. Pinned so a future "no two categories share a
    // colour" claim has to face this.
    const builtinHues = new Set<string>(Object.values(BUILTIN_CATEGORY_INDEX).map((i) => CATEGORY_COLORS[i]));
    expect(builtinHues.size).toBe(13);
    expect(CATEGORY_COLORS.length - builtinHues.size).toBe(7);   // the 7 hues only a custom id reaches
    const customs = Array.from({ length: 200 }, (_, i) => `custom-${i}`);
    expect(customs.filter((id) => builtinHues.has(chartCategoryColor(id))).length).toBeGreaterThan(0);
  });
});

// --- the two Insights screen suites' exemplar slot -------------------------------------------
//
// Both screen suites prove "the screen forwards the stored slot" by giving `shopping` a slot and
// asserting the painted hue is the SLOT's, not the id's. That only proves anything while the two
// disagree — which is exactly what WHIT-432 broke for shopping's SEED slot, and why the fixtures
// moved to a slot it does not own. Nothing ties that number to the invariant it depends on, so read
// it back out of the fixtures and assert the invariant here, in the fast logic project.
const SCREEN_SUITES = ['insightsChartPalette.screen.test.tsx', 'insightsSlotRows.screen.test.tsx'];

function fixtureSlots(file: string): { shopping: number; all: number[] } {
  const src = fs.readFileSync(path.resolve(__dirname, file), 'utf8');
  const shopping = /\{[^}]*id:\s*'shopping'[^}]*colorSlot:\s*(\d+)[^}]*\}/.exec(src);
  if (!shopping) throw new Error(`no shopping fixture with a colorSlot in ${file}`);
  const all = [...src.matchAll(/^\s*\{\s*id:.*colorSlot:\s*(\d+)/gm)].map((m) => Number(m[1]));
  if (all.length === 0) throw new Error(`parsed 0 fixture colorSlots from ${file}`);
  return { shopping: Number(shopping[1]), all };
}

describe('[B4] the screen suites cannot silently go tautological again', () => {
  it.each(SCREEN_SUITES)('%s gives shopping a slot whose hue differs from its fallback', (file) => {
    const { shopping } = fixtureSlots(file);
    // the three ways this fixture could stop proving anything, each named
    expect(SERVER_SLOTS.shopping).not.toBe(shopping);                              // not its seed slot
    expect(ASSIGNMENT_ORDER[shopping]).not.toBe(BUILTIN_CATEGORY_INDEX.shopping);  // not its ramp position
    expect(chartCategoryColor('shopping', { slot: shopping }))
      .not.toBe(chartCategoryColor('shopping'));                                   // the hues really differ
  });

  it.each(SCREEN_SUITES)('%s fixture slots are all distinct, so no assertion passes by accident', (file) => {
    const { all } = fixtureSlots(file);
    expect(new Set(all).size).toBe(all.length);
    const painted = all.map((slot) => chartCategoryColor('irrelevant', { slot }));
    expect(new Set(painted).size).toBe(all.length);
  });
});
