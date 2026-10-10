// otherColorToken — WHIT-400 — the donut's "Other" grey has no home but a hex literal, so nothing
// stopped it drifting somewhere unreadable. It already had: at #565f89 it measured 2.91:1 against
// the chart background, under the 3:1 WCAG minimum for a graphic you need to make out, while every
// category colour sat at 8:1+ — in the ring it read more like a gap than a wedge.
//
// This file guards the two properties that make the wedge work, rather than the hex itself:
//   [Q19] it lifts far enough off the chart background to be seen;
//   [Q25] it stays far enough from the category ramp to read as "not one thing".
// Between them a future retune can't make it invisible OR make it look like a category.
//
// The FADED state (a wedge stepping back when another is tapped) is guarded by
// wedgeFadeLevel.logic.test.ts.
//
// Note what is deliberately NOT here. The card asked to pin OTHER_COLOR === C.textFaint, which was
// true when it was filed. Fixing the contrast broke that equality on purpose: the wedge is a large
// fill chosen for contrast, C.textFaint is small ink chosen for legibility, and the two only ever
// matched by coincidence of the palette (C.placeholder is a third copy of that same old grey).
// Pinning the coincidence would now fight the fix.
//
// The WCAG maths is hand-written and lives in ./support/wcag, so measuring the shipped colours
// through it can never pass by agreeing with the code it pins.
import { describe, it, expect } from '@jest/globals';
import { OTHER_COLOR, CATEGORY_COLORS, CHART_BG } from '../chartColors';
import { contrastHex } from './support/wcag';

describe('the "Other" wedge stays visible and stays un-category-like', () => {
  it('[Q19] OTHER_COLOR clears the 3:1 minimum against the chart background', () => {
    // The bar is WCAG 1.4.11 non-text contrast: a graphic you need to understand the content.
    // At rest this is the only thing separating the wedge from the ring track behind it.
    expect(contrastHex(OTHER_COLOR, CHART_BG)).toBeGreaterThanOrEqual(3);
  });

  it('[Q25] OTHER_COLOR stays clearly distinct from every category colour', () => {
    // The ramp is equi-luminant (every entry at OKLCH L 0.765); the wedge sits well below it, so a
    // brightening retune is the way this would break. 1.5:1 is the floor — below that the grey
    // starts reading as just another slice, which is the one thing "Other" must never do.
    const nearest = Math.min(...CATEGORY_COLORS.map((c) => contrastHex(OTHER_COLOR, c)));
    expect(nearest).toBeGreaterThanOrEqual(1.5);
  });
});
