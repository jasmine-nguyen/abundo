// WHIT-425 — direct tests for src/contrast.ts, the module that works out how far a donut wedge may
// fade and still clear WCAG 1.4.11's 3:1 against the ring track.
//
// otherColorToken.logic.test.ts measures the SHIPPED COLOURS through this module with its own
// independent helper. This file does the opposite job: it tests the module's own edges — the hex
// shapes it must parse, the endpoints of the blend, and the two fallback paths that never fire in
// production. Those fallbacks are exactly where a silent regression could hide.
import { describe, it, expect } from '@jest/globals';
import {
  parseHexColor,
  relativeLuminance,
  contrastRatio,
  compositeOver,
  wedgeDimOpacity,
  WEDGE_DIM_TARGET,
} from '../contrast';
import { CHART_BG } from '../chartColors';

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
