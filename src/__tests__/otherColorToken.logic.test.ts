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
// WHIT-425 extends the same idea to the FADED state, which [Q19] never covered: tapping a wedge
// used to drop every other wedge to a flat 40%, landing them at 1.65–2.46:1 — invisible by the very
// bar [Q19] enforces at rest. The fade is now derived per colour instead.
//   [Q27] every colour that fades still clears 3:1 once faded;
//   [Q28] the fade is still a fade — no wedge quietly stops fading to buy contrast;
//   [Q29] "Other" is exempt from the fade, and clears the bar unfaded.
//
// Note what is deliberately NOT here. The card asked to pin OTHER_COLOR === C.textFaint, which was
// true when it was filed. Fixing the contrast broke that equality on purpose: the wedge is a large
// fill chosen for contrast, C.textFaint is small ink chosen for legibility, and the two only ever
// matched by coincidence of the palette (C.placeholder is a third copy of that same old grey).
// Pinning the coincidence would now fight the fix.
import { describe, it, expect } from '@jest/globals';
import { OTHER_COLOR, CATEGORY_COLORS, CHART_BG } from '../chartColors';
import { wedgeDimOpacity, WEDGE_DIM_MAX } from '../contrast';
import { C } from '../theme';

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

// A faded wedge's colour as it actually reaches the eye: blended over the opaque track behind it.
// Inlined for the same reason as luminance() above — measuring src/contrast.ts with src/contrast.ts
// would only prove it agrees with itself.
function faded(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  const bg = parseInt(CHART_BG.slice(1), 16);
  const mix = (shift: number) => {
    const f = (n >> shift) & 255;
    const b = (bg >> shift) & 255;
    return Math.round(alpha * f + (1 - alpha) * b);
  };
  return `#${((mix(16) << 16) | (mix(8) << 8) | mix(0)).toString(16).padStart(6, '0')}`;
}

// Every colour a donut wedge can actually be painted, EXCEPT "Other" (which no longer fades — see
// [Q29]). Two sources, both real: the Insights ramp, and C.purple for the Uncategorized row
// (src/context.tsx builds it with C.purple; app/(tabs)/insights.tsx only recolours rows that map to
// a category, and Uncategorized has none, so the theme purple survives into the ring). Refund,
// remainder and "Directly in X" rows are all depth >= 1, so they never become wedges — this list is
// closed. C.purple is the one a palette retune would most easily forget.
const FADING_WEDGE_COLORS = [...CATEGORY_COLORS, C.purple];

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
    // Same self-check for the blend the WHIT-425 guards below lean on: fully opaque is the wedge,
    // fully transparent is the track. A blend that ignored alpha would make [Q27] meaningless.
    expect(faded(OTHER_COLOR, 1)).toBe(OTHER_COLOR);
    expect(faded(OTHER_COLOR, 0)).toBe(CHART_BG);
  });
});

describe('a faded wedge stays visible (WHIT-425)', () => {
  it('[Q27] every wedge colour that fades still clears 3:1 once faded', () => {
    // The bug: a flat 0.4 fade put these at 2.31–2.46:1, under the same bar [Q19] holds the resting
    // wedge to. FAIL-ON-REVERT: restore a flat 0.4 and this reddens on every colour in the list.
    for (const color of FADING_WEDGE_COLORS) {
      expect(contrast(faded(color, wedgeDimOpacity(color)), CHART_BG)).toBeGreaterThanOrEqual(3);
      expect(contrast(faded(color, 0.4), CHART_BG)).toBeLessThan(3); // what the old flat fade did
    }
  });

  it('[Q28] the fade is still a fade — no wedge buys its contrast by not fading', () => {
    // The cheap way to pass [Q27] is to stop fading. The clamp exists for colours we cannot measure,
    // and nothing paintable should ever reach it: today the worst is 0.534 against a 0.85 ceiling.
    // If a palette retune ever pushes a wedge into that escape hatch, this is what says so.
    for (const color of FADING_WEDGE_COLORS) {
      expect(wedgeDimOpacity(color)).toBeLessThan(WEDGE_DIM_MAX);
    }
  });

  it('[Q29] "Other" clears the bar unfaded, which is why it can sit the highlight out', () => {
    // "Other" is the synthesised fold bucket, not a real category, so it does not fade at all — see
    // dimOpacityFor in SpendingDonut. Its own contrast floor would have been 0.825, which is barely
    // a fade and would have made the one non-category wedge the second-brightest thing on the ring.
    // Exempting it is only safe because it already clears 3:1 at full opacity, which is [Q19]. This
    // pins the link: if a retune ever drops it below the bar, exempting it stops being safe.
    expect(contrast(OTHER_COLOR, CHART_BG)).toBeGreaterThanOrEqual(3);
    expect(contrast(faded(OTHER_COLOR, 0.4), CHART_BG)).toBeLessThan(2); // the bug: 1.65:1
  });
});
