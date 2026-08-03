// WHIT-425 (QA gap) — [Q35]-[Q40], the edges src/contrast.ts's own suite and the [Q27]-[Q29] token
// guards leave open.
//
// contrast.logic.test.ts tests the module's happy shapes and its two fallback paths.
// otherColorToken.logic.test.ts measures the SHIPPED colours through it. Neither pins:
//   • that the derived fade is a fade you can SEE (< WEDGE_DIM_MAX is satisfied by 0.849);
//   • the one input shape that CRASHES instead of falling back;
//   • the bisection's "whether fg is lighter or darker" claim (only the darker-on-lighter
//     direction is ever exercised — the app has one, near-black, track);
//   • the whitespace/length edges of the hex regex;
//   • the invariant the "Other" EXEMPTION rests on, as opposed to the one [Q29] states.
// Measurements are made with this file's own independently written helpers, never with
// src/contrast.ts, so nothing here can pass by agreeing with the code it pins.
import { describe, it, expect } from '@jest/globals';
import {
  parseHexColor,
  minOpacityForContrast,
  wedgeDimOpacity,
  WEDGE_DIM_MAX,
  WEDGE_DIM_TARGET,
} from '../contrast';
import { CATEGORY_COLORS, OTHER_COLOR, CHART_BG } from '../chartColors';
import { C } from '../theme';

// --- independent WCAG helpers (deliberately NOT imported from src/contrast.ts) ---
const rgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const lin = (v: number) => {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};
const lum = (c: number[]) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
const ratio = (a: number[], b: number[]) =>
  (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
const over = (fg: number[], bg: number[], alpha: number) =>
  [0, 1, 2].map((i) => alpha * fg[i] + (1 - alpha) * bg[i]);

const TRACK = rgb(CHART_BG);
// A wedge as the eye receives it: its colour blended over the opaque track at `alpha`.
const painted = (hex: string, alpha: number) => over(rgb(hex), TRACK, alpha);

// Every colour a wedge that FADES can be painted (the ramp + the Uncategorized purple). Mirrors
// FADING_WEDGE_COLORS in otherColorToken.logic.test.ts; "Other" is excluded because it is exempt.
const FADING = [...CATEGORY_COLORS, C.purple];

describe('contrast — the input shapes that must degrade, not crash', () => {
  it('[Q36] a non-string colour lands on the clamp instead of throwing', () => {
    // DonutSlice.color is `string` to the compiler, but the value is network-derived and
    // chartColors.ts documents `undefined` reaching a wedge's stroke when a corrupt colorSlot comes
    // off the wire — calling it "an INVISIBLE slice - no crash". wedgeDimOpacity runs at RENDER
    // time, so without the typeof guard that same row takes the whole Insights tab down.
    expect(wedgeDimOpacity(undefined as unknown as string)).toBe(WEDGE_DIM_MAX);
    expect(wedgeDimOpacity(null as unknown as string)).toBe(WEDGE_DIM_MAX);
    // Everything that IS a string degrades the same way.
    for (const bad of ['', '   ', 'red', 'rgba(122,162,247,.4)', '#12345', '#1234567']) {
      expect(wedgeDimOpacity(bad)).toBe(WEDGE_DIM_MAX);
    }
  });
});

describe('contrast — the primitives at the edges nobody exercises', () => {
  it('[Q37] the bisection also works with a DARK wedge on a LIGHT backdrop', () => {
    // contrast.ts:69-70 claims validity "whether fg is lighter or darker". The app only ever has
    // the lighter-on-darker case (one near-black track), so the darker branch is unmeasured — and
    // a bisection whose comparison ran the wrong way would still return a plausible 0-1 number.
    const floor = minOpacityForContrast([0, 0, 0], [255, 255, 255], WEDGE_DIM_TARGET);
    expect(floor).not.toBeNull();
    expect(ratio(over([0, 0, 0], [255, 255, 255], floor!), [255, 255, 255]))
      .toBeGreaterThanOrEqual(WEDGE_DIM_TARGET);
    // ...and it is the SMALLEST such opacity: a hair less no longer clears.
    expect(ratio(over([0, 0, 0], [255, 255, 255], floor! - 0.005), [255, 255, 255]))
      .toBeLessThan(WEDGE_DIM_TARGET);
    // Same wedge colour used as the wedge AND the backdrop can never clear — 1:1 at every opacity.
    expect(minOpacityForContrast(rgb('#65baff'), rgb('#65baff'), WEDGE_DIM_TARGET)).toBeNull();
  });

  it('[Q38] the hex regex trims, and rejects the 5- and 7-digit near-misses', () => {
    // parseHexColor trims (contrast.ts:32) — untested, and a colour arriving with whitespace from
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
