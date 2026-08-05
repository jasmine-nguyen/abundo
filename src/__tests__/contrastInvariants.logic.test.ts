// WHIT-460 — the contrast/colour-measurement invariants, one file. Folds three WHIT-425 logic suites:
//   • contrast.logic     — src/contrast.ts's OWN edges: hex parsing, the blend endpoints, the two null paths
//   • contrastEdges      — the edges contrast.ts's own suite + the token guards leave open (degrade-not-crash,
//                          dark-on-light bisection, hex near-misses)
//   • otherColorToken    — measures the SHIPPED wedge colours through independent maths
//
// IMPORTANT — TWO IMPLEMENTATIONS LIVE IN THIS FILE, ON PURPOSE.
//   • The REAL module under test (src/contrast.ts) is imported under its PLAIN names
//     (parseHexColor, contrastRatio, compositeOver, relativeLuminance, minOpacityForContrast,
//     wedgeDimOpacity, …). Only the contrast.logic block — whose job is to test that module's own
//     behaviour — asserts against these.
//   • The INDEPENDENT hand-written WCAG maths (./support/wcag) is imported under wcag* names
//     (wcagRgb, wcagRatio, wcagOver, wcagContrastHex, wcagFadedOver). The contrastEdges and
//     otherColorToken blocks MEASURE the shipped colours (and feed the real module's primitives)
//     through these — never through the code they pin. Per the support/wcag header, "nothing here
//     can pass by agreeing with the code it pins." Keep that split when editing: a measurement in
//     those two blocks must reference a wcag* binding, not the plain real-module name.
import { describe, it, expect } from '@jest/globals';
import {
  parseHexColor,
  relativeLuminance,
  contrastRatio,
  compositeOver,
  minOpacityForContrast,
  wedgeDimOpacity,
  WEDGE_DIM_TARGET,
  WEDGE_DIM_CEILING,
} from '../contrast';
import { OTHER_COLOR, CATEGORY_COLORS, CHART_BG } from '../chartColors';
import { C } from '../theme';
// Independent WCAG maths, hand-written and shared (never from src/contrast.ts — see support/wcag's
// header). Aliased to wcag* so the shipped-colour measurements below can never pass by agreeing
// with the code they pin, and so they cannot collide with the real module's plain names above.
import {
  hexToRgb as wcagRgb,
  contrastRatio as wcagRatio,
  compositeOver as wcagOver,
  contrastHex as wcagContrastHex,
  fadedOver as wcagFadedOver,
} from './support/wcag';

// ============================================================================================
// contrast.logic — WHIT-425 — direct tests for src/contrast.ts, the module that works out how far a
// donut wedge may fade and still clear WCAG 1.4.11's 3:1 against the ring track.
//
// The otherColorToken block below measures the SHIPPED COLOURS through the independent helper. This
// block does the opposite job: it tests the module's own edges — the hex shapes it must parse, the
// endpoints of the blend, and the two fallback paths that never fire in production. Those fallbacks
// are exactly where a silent regression could hide. It therefore asserts against the REAL module
// (plain names) throughout, including its own local `rgb` parse.
// ============================================================================================

const rgb = (color: string) => {
  const parsed = parseHexColor(color);
  if (!parsed) throw new Error(`unparseable in test fixture: ${color}`);
  return parsed.rgb;
};

// What a wedge painted `color` actually measures against the track at `alpha` opacity.
const contrastAt = (color: string, alpha: number) =>
  contrastRatio(compositeOver(rgb(color), rgb(CHART_BG), alpha), rgb(CHART_BG));

describe('contrast — parsing every hex shape this codebase writes', () => {
  it('[Q30] accepts 3/4/6/8-digit hex in either case, and rejects what is not hex', () => {
    // The donut palette is lowercase but the test fixtures are not (#7FD49B, #E8A87C), and
    // themeLiterals proves the project also writes #abc, #abcd and 8-digit forms. A lowercase-only
    // or 6-digit-only parser would quietly fall through to the clamp and kill the fade instead of
    // failing loudly — so this is the fail-on-revert for that whole class of bug.
    expect(parseHexColor('#abc')?.rgb).toEqual([0xaa, 0xbb, 0xcc]);
    expect(parseHexColor('#7FD49B')?.rgb).toEqual([0x7f, 0xd4, 0x9b]);
    expect(parseHexColor('#7fd49b')?.rgb).toEqual([0x7f, 0xd4, 0x9b]);
    expect(parseHexColor('#7FD49B')).toEqual(parseHexColor('#7fd49b')); // case must not matter

    // Alpha rides along on the 4- and 8-digit shapes, and defaults to opaque otherwise.
    expect(parseHexColor('#abcd')?.alpha).toBeCloseTo(0xdd / 255, 5);
    expect(parseHexColor('#7c8cffcc')?.alpha).toBeCloseTo(0xcc / 255, 5);
    expect(parseHexColor('#7aa2f7')?.alpha).toBe(1);

    for (const notHex of ['red', 'rgba(1,2,3,.5)', '#12345', '#xyzxyz', '', '7aa2f7']) {
      expect(parseHexColor(notHex)).toBeNull();
    }
  });
});

describe('contrast — the primitives the fade is derived from', () => {
  it('[Q31] luminance, ratio and blend agree with known values', () => {
    // Without this a broken primitive could return a constant and every guard built on it would
    // pass on anything. Black/white is 21:1 by definition; a colour against itself is 1:1.
    expect(contrastRatio(rgb('#ffffff'), rgb('#000000'))).toBeCloseTo(21, 5);
    expect(contrastRatio(rgb('#6b74a0'), rgb('#6b74a0'))).toBeCloseTo(1, 5);
    expect(relativeLuminance(rgb('#000000'))).toBeCloseTo(0, 5);
    expect(relativeLuminance(rgb('#ffffff'))).toBeCloseTo(1, 5);

    // The blend's endpoints: fully opaque is the wedge itself, fully transparent is the backdrop.
    expect(compositeOver(rgb('#7aa2f7'), rgb(CHART_BG), 1)).toEqual(rgb('#7aa2f7'));
    expect(compositeOver(rgb('#7aa2f7'), rgb(CHART_BG), 0)).toEqual(rgb(CHART_BG));
  });
});

describe('contrast — the fade a wedge is given', () => {
  it('[Q32] returns the SMALLEST opacity that still clears the target', () => {
    // Both halves matter. Clearing the target alone would be satisfied by returning 1 (no fade);
    // being minimal alone would be satisfied by returning something invisible. Together they pin
    // the actual contract: fade as far as possible, but no further.
    for (const color of ['#7aa2f7', '#7FD49B', '#6b74a0', '#bb9af7']) {
      const dim = wedgeDimOpacity(color);
      expect(dim).not.toBeNull();
      expect(contrastAt(color, dim!)).toBeGreaterThanOrEqual(WEDGE_DIM_TARGET);
      expect(contrastAt(color, dim! - 0.005)).toBeLessThan(WEDGE_DIM_TARGET);
      // Rounded UP to 3 decimals, so the shipped value always clears and the screen tests can pin
      // exact numbers rather than chasing float noise.
      expect(dim!).toBeCloseTo(Math.ceil(dim! * 1000) / 1000, 10);
    }
  });

  it('[Q33] both failure paths return null — the module measures, or admits it cannot', () => {
    // The module no longer bakes in a fallback: it returns null both for a colour it cannot measure
    // and for one that cannot clear the bar at ANY opacity. The caller (SpendingDonut) substitutes
    // the visible step-back, WEDGE_DIM_FALLBACK — that seam is pinned by the screen test [A59]. The
    // dangerous silent "no fade" (returning 1) is impossible from here.
    expect(wedgeDimOpacity('not-a-colour')).toBeNull();
    // #565f89 is the pre-WHIT-400 grey: it tops out at 2.91:1 even fully opaque, so no fade saves it.
    expect(contrastAt('#565f89', 1)).toBeLessThan(WEDGE_DIM_TARGET);
    expect(wedgeDimOpacity('#565f89')).toBeNull();
    // A see-through track leaves us guessing at what sits behind it — refuse rather than guess.
    expect(wedgeDimOpacity('#7aa2f7', '#16161e80')).toBeNull();
  });

  it('[Q34] a colour carrying its own alpha needs a higher group opacity, or takes the fallback', () => {
    // SVG multiplies a stroke's alpha by its group opacity. Ignoring that would under-fade a
    // translucent wedge into invisibility while the maths reported success.
    const opaque = wedgeDimOpacity('#7aa2f7');
    const slightAlpha = wedgeDimOpacity('#7aa2f7f0'); // 94% alpha: still reachable
    expect(opaque).not.toBeNull();
    expect(slightAlpha).not.toBeNull();
    expect(slightAlpha!).toBeGreaterThan(opaque!);
    // ...and it must genuinely still be a fade that clears the bar, not a degenerate 1. Asserting
    // only "higher than opaque" would be satisfied by returning 1, which is the no-fade result the
    // whole module exists to avoid.
    expect(slightAlpha!).toBeLessThan(1);
    const parsed = parseHexColor('#7aa2f7f0')!;
    expect(contrastAt('#7aa2f7', parsed.alpha * slightAlpha!)).toBeGreaterThanOrEqual(WEDGE_DIM_TARGET);

    // Half alpha cannot reach the target even at full group opacity, so it returns null (the caller
    // substitutes the fallback) rather than silently painting at 2.73:1 with no fade at all.
    expect(wedgeDimOpacity('#7aa2f780')).toBeNull();
    expect(wedgeDimOpacity('#7aa2f700')).toBeNull(); // fully transparent: nothing to fade
  });
});

// ============================================================================================
// contrastEdges — WHIT-425 (QA gap) — [Q36]-[Q38], the edges src/contrast.ts's own suite and the
// [Q27]-[Q29] token guards leave open.
//
// The contrast.logic block above tests the module's happy shapes and its two fallback paths. The
// otherColorToken block below measures the SHIPPED colours through it. Neither pins:
//   • the input shapes that must degrade to null (not crash the screen);
//   • the bisection on a wedge LIGHTER than its backdrop — the app has one near-black track, so
//     only the one direction is ever exercised in production;
//   • the whitespace and near-miss-length edges of the hex regex.
// Measurements are made with the shared hand-written helper (wcag* below), never with
// src/contrast.ts, so nothing here can pass by agreeing with the code it pins.
// ============================================================================================

describe('contrast — the input shapes that must degrade, not crash', () => {
  it('[Q36] a non-string colour returns null instead of throwing', () => {
    // DonutSlice.color is `string` to the compiler, but the value is network-derived and
    // chartColors.ts documents `undefined` reaching a wedge's stroke when a corrupt colorSlot comes
    // off the wire — calling it "an INVISIBLE slice - no crash". wedgeDimOpacity runs at RENDER
    // time, so without the typeof guard that same row takes the whole Insights tab down. It returns
    // null when it cannot measure — the caller (SpendingDonut) substitutes the drawing fallback.
    expect(wedgeDimOpacity(undefined as unknown as string)).toBeNull();
    expect(wedgeDimOpacity(null as unknown as string)).toBeNull();
    // Everything that IS a string degrades the same way.
    for (const bad of ['', '   ', 'red', 'rgba(122,162,247,.4)', '#12345', '#1234567']) {
      expect(wedgeDimOpacity(bad)).toBeNull();
    }
  });
});

describe('contrast — the primitives at the edges nobody exercises', () => {
  it('[Q37] the bisection also works with a DARK wedge on a LIGHT backdrop', () => {
    // contrast.ts:73-74 claims validity "whether fg is lighter or darker". The app only ever has
    // the lighter-on-darker case (one near-black track), so the darker branch is unmeasured — and
    // a bisection whose comparison ran the wrong way would still return a plausible 0-1 number.
    const floor = minOpacityForContrast([0, 0, 0], [255, 255, 255], WEDGE_DIM_TARGET);
    expect(floor).not.toBeNull();
    expect(wcagRatio(wcagOver([0, 0, 0], [255, 255, 255], floor!), [255, 255, 255]))
      .toBeGreaterThanOrEqual(WEDGE_DIM_TARGET);
    // ...and it is the SMALLEST such opacity: a hair less no longer clears.
    expect(wcagRatio(wcagOver([0, 0, 0], [255, 255, 255], floor! - 0.005), [255, 255, 255]))
      .toBeLessThan(WEDGE_DIM_TARGET);
    // Same wedge colour used as the wedge AND the backdrop can never clear — 1:1 at every opacity.
    expect(minOpacityForContrast(wcagRgb('#65baff'), wcagRgb('#65baff'), WEDGE_DIM_TARGET)).toBeNull();
  });

  it('[Q38] the hex regex trims, and rejects the 5- and 7-digit near-misses', () => {
    // parseHexColor trims (contrast.ts:36) — untested, and a colour arriving with whitespace from
    // a config string would otherwise silently clamp instead of fading.
    expect(parseHexColor('  #ABC  ')).toEqual(parseHexColor('#aabbcc'));
    expect(parseHexColor('\t#7aa2f7\n')).toEqual(parseHexColor('#7aa2f7'));
    // 5 and 7 digits are the shapes a typo produces. `{3,4}|{6}|{8}` must reject both rather than
    // matching a prefix — a partial match would resolve to a WRONG colour and fade to a wrong floor.
    expect(parseHexColor('#12345')).toBeNull();
    expect(parseHexColor('#1234567')).toBeNull();
    expect(parseHexColor('#')).toBeNull();
    expect(parseHexColor('#7aa2f7 #7aa2f7')).toBeNull();
    // Alpha 0 on the 8-digit shape parses (it is valid hex) — wedgeDimOpacity, not the parser, is
    // what refuses it. Keeps the two responsibilities pinned apart.
    expect(parseHexColor('#7aa2f700')?.alpha).toBe(0);
  });
});

// ============================================================================================
// otherColorToken — WHIT-400 — the donut's "Other" grey has no home but a hex literal, so nothing
// stopped it drifting somewhere unreadable. It already had: at #565f89 it measured 2.91:1 against
// the chart background, under the 3:1 WCAG minimum for a graphic you need to make out, while every
// category colour sat at 8:1+ — in the ring it read more like a gap than a wedge.
//
// This block guards the two properties that make the wedge work, rather than the hex itself:
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
//
// The WCAG maths is hand-written and lives in ./support/wcag (imported as wcag* above) —
// deliberately NOT src/contrast.ts, so measuring the shipped colours through it can never pass by
// agreeing with the code it pins. See that file's header for why it stays hand-written and unrounded.
// ============================================================================================

const bg = wcagRgb(CHART_BG);

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
    expect(wcagContrastHex(OTHER_COLOR, CHART_BG)).toBeGreaterThanOrEqual(3);
  });

  it('[Q25] OTHER_COLOR stays clearly distinct from every category colour', () => {
    // The ramp is equi-luminant (every entry at OKLCH L 0.765); the wedge sits well below it, so a
    // brightening retune is the way this would break. 1.5:1 is the floor — below that the grey
    // starts reading as just another slice, which is the one thing "Other" must never do.
    const nearest = Math.min(...CATEGORY_COLORS.map((c) => wcagContrastHex(OTHER_COLOR, c)));
    expect(nearest).toBeGreaterThanOrEqual(1.5);
  });

  it('[Q26] the contrast helper agrees with known values, so the two guards above mean something', () => {
    // Without this, a broken luminance() could return a constant and both guards would pass on
    // anything. Black-on-white is 21:1 by definition; a colour against itself is 1:1.
    expect(wcagContrastHex('#ffffff', '#000000')).toBeCloseTo(21, 5);
    expect(wcagContrastHex(OTHER_COLOR, OTHER_COLOR)).toBeCloseTo(1, 5);
    // And the old grey really did fail the [Q19] bar — this is the regression being fixed.
    expect(wcagContrastHex('#565f89', CHART_BG)).toBeLessThan(3);
    // Same self-check for the blend the WHIT-425 guards below lean on: fully opaque is the wedge,
    // fully transparent is the track. A blend that ignored alpha would make [Q27] meaningless.
    expect(wcagFadedOver(OTHER_COLOR, 1, CHART_BG)).toEqual(wcagRgb(OTHER_COLOR));
    expect(wcagFadedOver(OTHER_COLOR, 0, CHART_BG)).toEqual(bg);
  });
});

describe('a faded wedge stays visible (WHIT-425)', () => {
  it('[Q27] every wedge colour clears 3:1 once faded', () => {
    // The bug: a flat 0.4 fade put these at 1.65–2.46:1, under the same bar [Q19] holds the resting
    // wedge to. FAIL-ON-REVERT: restore a flat 0.4 and this reddens on every colour in the list.
    for (const color of WEDGE_COLORS) {
      const fade = wedgeDimOpacity(color);
      expect(fade).not.toBeNull();
      expect(wcagRatio(wcagFadedOver(color, fade!, CHART_BG), bg)).toBeGreaterThanOrEqual(3);
      expect(wcagRatio(wcagFadedOver(color, 0.4, CHART_BG), bg)).toBeLessThan(3); // the old flat fade
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
    const measured = WEDGE_COLORS.map((c, i) => wcagRatio(wcagFadedOver(c, fades[i], CHART_BG), bg));
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
