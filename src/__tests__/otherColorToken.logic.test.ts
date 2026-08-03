// WHIT-400 — the donut's "Other" grey has no home but a hex literal, so nothing stopped it drifting
// somewhere unreadable. It already had: at #565f89 it measured 2.91:1 against the chart background,
// under the 3:1 WCAG minimum for a graphic you need to make out, while every category colour sat at
// 8:1+ — in the ring it read more like a gap than a wedge.
//
// This file guards the two properties that make the wedge work, rather than the hex itself:
//   [Q19] it lifts far enough off the chart background to be seen;
//   [Q25] it stays far enough from the category ramp to read as "not one thing".
// Between them a future retune can't make it invisible OR make it look like a category.
//
// Note what is deliberately NOT here. The card asked to pin OTHER_COLOR === C.textFaint, which was
// true when it was filed. Fixing the contrast broke that equality on purpose: the wedge is a large
// fill chosen for contrast, C.textFaint is small ink chosen for legibility, and the two only ever
// matched by coincidence of the palette (C.placeholder is a third copy of that same old grey).
// Pinning the coincidence would now fight the fix.
import { describe, it, expect } from '@jest/globals';
import { OTHER_COLOR, CATEGORY_COLORS, CHART_BG } from '../chartColors';

// WCAG 2.x relative luminance + contrast ratio. Inlined rather than imported: the point is to
// measure the shipped constants independently, and the app has no contrast helper to reuse.
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return [16, 8, 0]
    .map((shift) => ((n >> shift) & 255) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)))
    .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
}

function contrast(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

describe('the "Other" wedge stays visible and stays un-category-like', () => {
  it('[Q19] OTHER_COLOR clears the 3:1 minimum against the chart background', () => {
    // The bar is WCAG 1.4.11 non-text contrast: a graphic you need to understand the content.
    // At rest this is the only thing separating the wedge from the ring track behind it.
    expect(contrast(OTHER_COLOR, CHART_BG)).toBeGreaterThanOrEqual(3);
  });

  it('[Q25] OTHER_COLOR stays clearly distinct from every category colour', () => {
    // The ramp is equi-luminant (every entry at OKLCH L 0.765); the wedge sits well below it, so a
    // brightening retune is the way this would break. 1.5:1 is the floor — below that the grey
    // starts reading as just another slice, which is the one thing "Other" must never do.
    const nearest = Math.min(...CATEGORY_COLORS.map((c) => contrast(OTHER_COLOR, c)));
    expect(nearest).toBeGreaterThanOrEqual(1.5);
  });

  it('[Q26] the contrast helper agrees with known values, so the two guards above mean something', () => {
    // Without this, a broken luminance() could return a constant and both guards would pass on
    // anything. Black-on-white is 21:1 by definition; a colour against itself is 1:1.
    expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 5);
    expect(contrast(OTHER_COLOR, OTHER_COLOR)).toBeCloseTo(1, 5);
    // And the old grey really did fail the [Q19] bar — this is the regression being fixed.
    expect(contrast('#565f89', CHART_BG)).toBeLessThan(3);
  });
});
