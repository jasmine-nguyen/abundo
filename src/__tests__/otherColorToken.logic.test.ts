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
  // "Other" wedge follows the new grey — and the trade-off cuts BOTH ways, so whoever trips this
  // should hear both halves. The likeliest reason C.textFaint moves is making small text legible.
  // Following it would push the wedge toward the ramp it is deliberately outside of (a x1.4
  // brighten drops its separation from the dimmest ramp colour from 2.77:1 to 1.59:1) — but it
  // would also LIFT the wedge off the chart background, from 2.91:1 to 5.07:1, fixing a real
  // contrast problem the wedge has today. Neither answer is obviously right; that is exactly why
  // this is a tripwire and not a derivation, which would make the repaint silent either way.
  //
  // Scope, honestly: the two greys never appear on the same screen (C.textFaint is absent from
  // the Insights screen entirely), so drift here breaks nothing visually. This is palette
  // hygiene, not a rendering safeguard. The drifts that WOULD be visible are pinned elsewhere —
  // [Q14] (no wedge may equal CHART_BG) and chartColors.logic.test.ts (no category may equal
  // OTHER_COLOR). What makes THIS one load-bearing is [Q20]/[Q21] in
  // spendingDonutOtherColor.screen.test.tsx, which pin that the wedge is painted from the token
  // at all — without them this guards one end of a chain whose other end nothing checks.
  it('[Q19] OTHER_COLOR still equals C.textFaint', () => {
    expect(OTHER_COLOR).toBe(C.textFaint);
  });

  // [Q19a] QA addition (WHIT-400) — [Q19] alone can pass VACUOUSLY. `toBe` cannot tell "these two
  // greys are equal" from "NEITHER OF THESE TOKENS EXISTS": rename BOTH `OTHER_COLOR` and
  // `C.textFaint` and each side resolves to `undefined`, `undefined === undefined`, green. Verified
  // by doing exactly that — the tripwire reported 1 passed with neither grey in the codebase.
  // `tsc --noEmit` catches that today only because both tokens have other consumers; a rename
  // refactor that updates its own call sites (the very moment a coincidental coupling gets lost)
  // leaves the typecheck green too. One line closes it: assert the value is a real hex first.
  it('[Q19a] both greys still exist — the tripwire cannot pass on two undefineds', () => {
    expect(OTHER_COLOR).toMatch(/^#[0-9a-f]{6}$/);
    expect(C.textFaint).toMatch(/^#[0-9a-f]{6}$/);
  });
});
