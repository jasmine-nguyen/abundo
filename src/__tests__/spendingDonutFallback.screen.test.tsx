// WHIT-430 (QA gap) — [A62]/[A63], the behaviour-parity seam the null+fallback split opened.
//
// Before WHIT-430 a single constant WEDGE_DIM_MAX = 0.85 was the opacity handed to EVERY wedge whose
// colour could not be measured (5 null-return branches). The split moved that number to SpendingDonut as
// WEDGE_DIM_FALLBACK and made wedgeDimOpacity return null, with the caller applying
// `wedgeDimOpacity(color) ?? WEDGE_DIM_FALLBACK`. "No visual change" is only true if that constant
// stays 0.85 AND every one of those branches still lands there. Nothing pinned either:
//   • [A59] asserts the render matches WEDGE_DIM_FALLBACK — but WHATEVER its value; it would pass at
//     0.5 just as happily, so it does not pin the historical 0.85.
//   • [Q33]/[Q34]/[Q36] assert null per-case, but never that null ∘ fallback reproduces 0.85, and
//     never touch the unparseable-BACKGROUND case at all.
// This is a screen-project file (not logic) only because WEDGE_DIM_FALLBACK lives in the component
// module, which pulls React Native — the assertions themselves render nothing.
import { describe, it, expect } from '@jest/globals';
import { WEDGE_DIM_FALLBACK } from '../components/SpendingDonut';
import { wedgeDimOpacity, WEDGE_DIM_CEILING } from '../contrast';

// The exact opacity a dimmed-but-unmeasurable wedge shipped at before WHIT-430 (the old
// WEDGE_DIM_MAX). Hard-coded ON PURPOSE: this is the historical baseline the refactor promised not to
// move, so it must be a literal here, not re-read from the code that is allowed to change.
const HISTORICAL_UNMEASURABLE_OPACITY = 0.85;

describe('WEDGE_DIM_FALLBACK — the unmeasurable-wedge opacity must not silently drift', () => {
  it('[A62] is still exactly the pre-split value, so an off-the-wire wedge fades as it always did', () => {
    // FAIL-ON-REVERT: change WEDGE_DIM_FALLBACK to anything but 0.85 in SpendingDonut.tsx and this
    // reddens. [A59] would not — it only checks the render equals whatever this constant happens to be.
    expect(WEDGE_DIM_FALLBACK).toBe(HISTORICAL_UNMEASURABLE_OPACITY);
    // It is a real step-back, never "no fade" (1) — a wedge that does not fade reads as the picked one.
    expect(WEDGE_DIM_FALLBACK).toBeLessThan(1);
    expect(WEDGE_DIM_FALLBACK).toBeGreaterThan(0);
    // The whole point of WHIT-430 was to stop ONE number doing two jobs: the "we gave up" fallback
    // and the "a real fade must dim below this" ceiling. Lock them as DISTINCT so a future edit can't
    // quietly re-conflate them back into a single value.
    expect(WEDGE_DIM_FALLBACK).not.toBe(WEDGE_DIM_CEILING);
  });

  it('[A63] the null+fallback split reproduces the old single constant for all 5 null branches (7 inputs)', () => {
    // Each input is one of the branches the old code sent to WEDGE_DIM_MAX. The contract under test
    // is the CALLER's composed expression: `wedgeDimOpacity(x) ?? WEDGE_DIM_FALLBACK`. Every one must
    // (a) measure to null, and (b) compose to the historical 0.85 — i.e. no case regained a measured
    // value, and the fallback still fills them. `??` (nullish), not `||`, is also pinned implicitly:
    // it must fire on null and ONLY on null.
    const unmeasurable: Array<[string, () => number | null]> = [
      ['unparseable wedge colour',     () => wedgeDimOpacity('not-a-colour')],
      ['empty-string wedge colour',    () => wedgeDimOpacity('')],
      ['unparseable BACKGROUND',       () => wedgeDimOpacity('#7aa2f7', 'nope')], // pinned nowhere else
      ['see-through track (alpha<1)',  () => wedgeDimOpacity('#7aa2f7', '#16161e80')],
      ['fully transparent wedge',      () => wedgeDimOpacity('#7aa2f700')],
      ['cannot clear at any opacity',  () => wedgeDimOpacity('#565f89')],        // floor === null
      ['alpha too low to ever clear',  () => wedgeDimOpacity('#7aa2f780')],      // groupOpacity > 1
    ];
    for (const [, measure] of unmeasurable) {
      const measured = measure();
      expect(measured).toBeNull();                                    // the module admits it cannot measure
      expect(measured ?? WEDGE_DIM_FALLBACK).toBe(HISTORICAL_UNMEASURABLE_OPACITY); // the caller fills to 0.85
    }
  });
});
