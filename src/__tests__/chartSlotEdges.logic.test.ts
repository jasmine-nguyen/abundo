// WHIT-402 — [A14] [A15] [A16] [A17] the adversarial half of the stored-slot colour resolution:
// the exotic values the existing 15-case reject list misses, the toCategory -> chartCategoryColor
// hand-off (nothing pins that the value one produces is usable by the other), and the
// mixed-state colours a partially-slotted store can show.
import { describe, it, expect } from '@jest/globals';
import {
  chartCategoryColor, normalizeColorSlot, ASSIGNMENT_ORDER, CATEGORY_COLORS,
  OTHER_COLOR,
} from '../chartColors';
import { toCategory } from '../context';
import { readServerSeedSlots } from './serverSeedSlots';

// The server's seed slots, READ from shared/repository_category.py — not retyped. A hand copy
// going stale is the whole reason WHIT-406/415/432 exist.
const SEED_SLOTS = readServerSeedSlots();

// chartCategoryColor's signature is `slot?: number` ON PURPOSE — a caller handing it a hex string is
// a bug the compiler should catch. But the values below arrive from the network, where the compiler
// guarantees nothing, so the RUNTIME guard has to hold on its own. `hostile()` is this file's single,
// deliberate hole in the type system: every non-number slot goes through it, so the casts are visible
// in one place instead of scattered `as any`s that would also hide a real type error.
const hostile = (slot: unknown) => ({ slot }) as { slot?: number };

describe('[A14] exotic slot values the reject list does not reach', () => {
  it('treats -0 as slot 0, not as absent and not as an out-of-range fallback', () => {
    // JSON.parse('-0') really is -0, and `-0 >= 0 && -0 < 20` is true, so it survives the guard and
    // indexes ASSIGNMENT_ORDER[-0] === ASSIGNMENT_ORDER[0]. Pinning it stops a future "reject
    // anything not strictly positive" tidy-up from quietly turning Eating Out into a fallback.
    expect(chartCategoryColor('coffee', { slot: -0 })).toBe(chartCategoryColor('coffee', { slot: 0 }));
    expect(chartCategoryColor('coffee', { slot: -0 })).toBe(CATEGORY_COLORS[0]);
    expect(chartCategoryColor('coffee', { slot: -0 })).not.toBe(chartCategoryColor('coffee'));
  });

  it('rejects boxed, bigint, whitespace and huge-integer slots — always a real ramp colour', () => {
    // `new Number(4)` is typeof 'object'; 4n is 'bigint'; 2**53 and MAX_SAFE_INTEGER are INTEGERS
    // that pass Number.isInteger and would index far past the end of the ramp.
    const exotic: unknown[] = [
      new Number(4), Number('4'), // eslint-disable-line no-new-wrappers -- Number('4') is fine, the box is the hostile case
      BigInt(4), '  ', ' 4 ', [4], [[4]], { valueOf: () => 4 }, { slot: 4 },
      Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, 2 ** 53, -(2 ** 31), 1e21, -1e21,
    ];
    for (const slot of exotic) {
      const colour = chartCategoryColor('coffee', hostile(slot));
      expect(CATEGORY_COLORS).toContain(colour);   // never undefined -> never an invisible wedge
      expect(colour).not.toBe(OTHER_COLOR);        // never the reserved "Other" grey
    }
    // Number('4') is the ONE genuine number in that list, so it resolves; every other entry falls
    // back. Asserting the split stops the loop above from passing on a blanket "everything falls
    // back" implementation.
    expect(chartCategoryColor('coffee', { slot: Number('4') })).toBe(chartCategoryColor('coffee', { slot: 4 }));
    for (const slot of [new Number(4), BigInt(4), '  ', ' 4 ', [4], { valueOf: () => 4 }] as unknown[]) {
      expect(chartCategoryColor('coffee', hostile(slot))).toBe(chartCategoryColor('coffee'));
    }
  });

  it('reads the slot off a frozen options bag and ignores a missing/odd bag entirely', () => {
    expect(chartCategoryColor('coffee', Object.freeze({ slot: 13 }))).toBe(CATEGORY_COLORS[ASSIGNMENT_ORDER[13]]);
    expect(chartCategoryColor('coffee', Object.create(null))).toBe(chartCategoryColor('coffee'));
    expect(chartCategoryColor('coffee', undefined)).toBe(chartCategoryColor('coffee'));
    // a blank id AND a garbage slot: still a real colour, never undefined
    expect(CATEGORY_COLORS).toContain(chartCategoryColor('', hostile('nope')));
    expect(CATEGORY_COLORS).toContain(chartCategoryColor(null, { slot: 42 }));
  });
});

describe('[A15] toCategory hands chartCategoryColor a value it can actually use', () => {
  it('round-trips every legal slot from the wire to the painted hex', () => {
    // The two halves are tested separately today; nothing pins the JOIN. A one-off in either (a
    // stringified slot, an off-by-one range) would leave both suites green and the chart wrong.
    const base = { id: 'coffee', name: 'Cafes & Coffee', bucket: 'Lifestyle', icon: 'coffee' };
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
  // not. Neither proves the resolver exists; builtinFallbackMirror [B1] and [A14]/[A15] do.
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

describe('[A17] slot resolution is total — no input can yield an invisible wedge', () => {
  it('never returns undefined or the reserved grey for ANY slot value', () => {
    const values: unknown[] = [
      ...Array.from({ length: 30 }, (_, i) => i - 5),         // -5 .. 24, straddling both bounds
      ...[0.1, -0.1, 19.999, 20.0001, NaN, Infinity, -Infinity, -0],
      ...['0', '19', '', ' ', 'NaN', true, false, null, undefined, {}, [], () => 4],
    ];
    for (const slot of values) {
      const colour = chartCategoryColor('somecustomcategory', hostile(slot));
      expect(typeof colour).toBe('string');
      expect(CATEGORY_COLORS).toContain(colour);
      expect(colour).not.toBe(OTHER_COLOR);
    }
  });

  it('normalizeColorSlot is exactly the 20 integers 0..19 and nothing else', () => {
    const accepted = [...Array(60).keys()].map((n) => n - 20).filter((n) => normalizeColorSlot(n) !== undefined);
    expect(accepted).toEqual([...Array(20).keys()]);
    // -0 survives the guard and is passed through UNCHANGED (`toBe`/`toEqual` use Object.is, so
    // it is not 0 to Jest) — but it indexes the ramp identically, which is what actually matters.
    expect(normalizeColorSlot(-0)).not.toBeUndefined();
    expect(Object.is(normalizeColorSlot(-0), -0)).toBe(true);
    expect(CATEGORY_COLORS[ASSIGNMENT_ORDER[normalizeColorSlot(-0) as number]]).toBe(CATEGORY_COLORS[0]);
  });
});
