// WHIT-425 (QA gap) — [Q36]-[Q38], the edges src/contrast.ts's own suite and the [Q27]-[Q29] token
// guards leave open.
//
// contrast.logic.test.ts tests the module's happy shapes and its two fallback paths.
// otherColorToken.logic.test.ts measures the SHIPPED colours through it. Neither pins:
//   • the input shapes that must degrade to null (not crash the screen);
//   • the bisection on a wedge LIGHTER than its backdrop — the app has one near-black track, so
//     only the one direction is ever exercised in production;
//   • the whitespace and near-miss-length edges of the hex regex.
// Measurements are made with the shared hand-written helper in ./support/wcag, never with
// src/contrast.ts, so nothing here can pass by agreeing with the code it pins.
import { describe, it, expect } from '@jest/globals';
import {
  parseHexColor,
  minOpacityForContrast,
  wedgeDimOpacity,
  WEDGE_DIM_TARGET,
} from '../contrast';
// Independent WCAG maths, hand-written and shared (never imported from src/contrast.ts — see the
// support/wcag header). Aliased to this file's short local names to keep the assertions below terse.
import { hexToRgb as rgb, contrastRatio as ratio, compositeOver as over } from './support/wcag';

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
    expect(ratio(over([0, 0, 0], [255, 255, 255], floor!), [255, 255, 255]))
      .toBeGreaterThanOrEqual(WEDGE_DIM_TARGET);
    // ...and it is the SMALLEST such opacity: a hair less no longer clears.
    expect(ratio(over([0, 0, 0], [255, 255, 255], floor! - 0.005), [255, 255, 255]))
      .toBeLessThan(WEDGE_DIM_TARGET);
    // Same wedge colour used as the wedge AND the backdrop can never clear — 1:1 at every opacity.
    expect(minOpacityForContrast(rgb('#65baff'), rgb('#65baff'), WEDGE_DIM_TARGET)).toBeNull();
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
