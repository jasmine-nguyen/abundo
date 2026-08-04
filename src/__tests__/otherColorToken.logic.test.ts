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
//   [Q27] every wedge colour still clears 3:1 once faded;
//   [Q28] they all land at the SAME visibility, though their fades differ widely;
//   [Q29] the fade is still a fade — no wedge quietly stops fading to buy contrast.
//
// Note what is deliberately NOT here. The card asked to pin OTHER_COLOR === C.textFaint, which was
// true when it was filed. Fixing the contrast broke that equality on purpose: the wedge is a large
// fill chosen for contrast, C.textFaint is small ink chosen for legibility, and the two only ever
// matched by coincidence of the palette (C.placeholder is a third copy of that same old grey).
// Pinning the coincidence would now fight the fix.
import { describe, it, expect } from '@jest/globals';
import { OTHER_COLOR, CATEGORY_COLORS, CHART_BG } from '../chartColors';
import { wedgeDimOpacity, WEDGE_DIM_CEILING } from '../contrast';
import { C } from '../theme';
import { contrastHex, contrastRatio, fadedOver, hexToRgb } from './support/wcag';

// The WCAG maths is hand-written and lives in ./support/wcag — deliberately NOT imported from
// src/contrast.ts, so measuring the shipped colours through it can never pass by agreeing with the
// code it pins. See that file's header for why it stays hand-written and unrounded.
const bg = hexToRgb(CHART_BG);

// Every colour a donut wedge can actually be painted. Three sources, all real: the Insights ramp,
// OTHER_COLOR for the fold bucket, and C.purple for the Uncategorized row (src/context.tsx builds it
// with C.purple; app/(tabs)/insights.tsx only recolours rows that map to a category, and
// Uncategorized has none, so the theme purple survives into the ring). Refund, remainder and
// "Directly in X" rows are all depth >= 1, so they never become wedges — this list is closed.
// C.purple is the one a palette retune would most easily forget.
const WEDGE_COLORS = [...CATEGORY_COLORS, OTHER_COLOR, C.purple];

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

  it('[Q26] the contrast helper agrees with known values, so the two guards above mean something', () => {
    // Without this, a broken luminance() could return a constant and both guards would pass on
    // anything. Black-on-white is 21:1 by definition; a colour against itself is 1:1.
    expect(contrastHex('#ffffff', '#000000')).toBeCloseTo(21, 5);
    expect(contrastHex(OTHER_COLOR, OTHER_COLOR)).toBeCloseTo(1, 5);
    // And the old grey really did fail the [Q19] bar — this is the regression being fixed.
    expect(contrastHex('#565f89', CHART_BG)).toBeLessThan(3);
    // Same self-check for the blend the WHIT-425 guards below lean on: fully opaque is the wedge,
    // fully transparent is the track. A blend that ignored alpha would make [Q27] meaningless.
    expect(fadedOver(OTHER_COLOR, 1, CHART_BG)).toEqual(hexToRgb(OTHER_COLOR));
    expect(fadedOver(OTHER_COLOR, 0, CHART_BG)).toEqual(bg);
  });
});

describe('a faded wedge stays visible (WHIT-425)', () => {
  it('[Q27] every wedge colour clears 3:1 once faded', () => {
    // The bug: a flat 0.4 fade put these at 1.65–2.46:1, under the same bar [Q19] holds the resting
    // wedge to. FAIL-ON-REVERT: restore a flat 0.4 and this reddens on every colour in the list.
    for (const color of WEDGE_COLORS) {
      const fade = wedgeDimOpacity(color);
      expect(fade).not.toBeNull();
      expect(contrastRatio(fadedOver(color, fade!, CHART_BG), bg)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(fadedOver(color, 0.4, CHART_BG), bg)).toBeLessThan(3); // the old flat fade
    }
  });

  it('[Q28] every faded wedge lands at the SAME visibility, whatever its own fade', () => {
    // The point of deriving per colour: the grey needs 0.825 and a bright ramp colour 0.49, but both
    // arrive at the same place. A shared fade cannot do this — at any single value the grey is
    // roughly a stop darker than the rest, which is the bug. Pinning the SPREAD (not just the floor)
    // is what stops a future "simplification" back to one number passing [Q27] on the bright colours
    // while the grey quietly fails.
    const fades = WEDGE_COLORS.map((c) => {
      const fade = wedgeDimOpacity(c);
      expect(fade).not.toBeNull();
      return fade!;
    });
    const measured = WEDGE_COLORS.map((c, i) => contrastRatio(fadedOver(c, fades[i], CHART_BG), bg));
    expect(Math.max(...measured) - Math.min(...measured)).toBeLessThan(0.2);
    // And the fades really do differ — otherwise the above passes trivially on a flat value.
    expect(Math.max(...fades) - Math.min(...fades)).toBeGreaterThan(0.25);
  });

  it('[Q29] the fade is still a fade — no wedge buys its contrast by not fading', () => {
    // The cheap way to pass [Q27] is to stop fading. This is a VISIBILITY ceiling (WEDGE_DIM_CEILING),
    // deliberately NOT the drawing fallback: a measured floor and the "we gave up" fallback are now
    // different things — wedgeDimOpacity returns null when it cannot measure, and the caller
    // substitutes WEDGE_DIM_FALLBACK for that. So the two can never be conflated by value the way the
    // old single WEDGE_DIM_MAX conflated them. The grey is the tightest real colour at 0.825, so the
    // slack here is on the ramp — which is exactly where a brightening retune would show up.
    for (const color of WEDGE_COLORS) {
      const fade = wedgeDimOpacity(color);
      expect(fade).not.toBeNull();
      expect(fade!).toBeLessThan(WEDGE_DIM_CEILING);
    }
  });
});
