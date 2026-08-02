// WHIT-400 — the donut's "Other" grey and the theme's faint ink are the same hex today, and the
// only thing saying so is a comment. Its sibling neutral CHART_BG already has this cover ([Q15] in
// chartDividerColor.logic.test.ts); OTHER_COLOR had none, so a theme retune could repaint one and
// not the other with nothing going red.
import { describe, it, expect } from '@jest/globals';
import { OTHER_COLOR } from '../chartColors';
import { C } from '../theme';

describe('the "Other" wedge grey still matches the faint ink it was copied from (tripwire)', () => {
  // [Q19] TRIPWIRE, not a design rule — the same shape and the same reasoning as [Q15].
  // OTHER_COLOR is deliberately its own token (chartColors.ts: "outside the ramp, low-saturation so
  // it reads as 'not one thing'"), and its rationale never says "because it is faint ink". The two
  // are equal today by coincidence of the Tokyo Night palette — C.placeholder is a third copy of
  // the same grey.
  //
  // So this failing is NOT automatically a bug. It is a prompt to decide, on purpose, whether the
  // "Other" wedge follows the new grey. The likeliest reason C.textFaint ever moves is making small
  // text more legible — and a wedge has no legibility constraint, while brightening it pushes it
  // toward the ramp it is deliberately outside of. Deriving one from the other would make that
  // repaint silent, which is the thing worth preventing.
  it('[Q19] OTHER_COLOR still equals C.textFaint', () => {
    expect(OTHER_COLOR).toBe(C.textFaint);
  });
});
