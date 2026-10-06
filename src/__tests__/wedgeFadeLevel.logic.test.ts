// WHIT-759 (QA) — the fixed fades must keep the look Jas signed off on (option B): a faded
// category slice CLEARLY steps back, and the faded grey "Other" ends up level with the faded
// categories, not brighter. wedgeFixedFade.logic.test.ts only guards the 3:1 floor and "< 0.9";
// a single flat 0.85 (option A) passes both. Measured with the independent ./support/wcag maths.
import { describe, it, expect } from '@jest/globals';
import { CATEGORY_COLORS, OTHER_COLOR, CHART_BG, wedgeDim } from '../chartColors';
import { C } from '../theme';
import { hexToRgb, contrastRatio, contrastHex, fadedOver } from './support/wcag';

const bg = hexToRgb(CHART_BG);
const fadedContrast = (color: string) => contrastRatio(fadedOver(color, wedgeDim(color), CHART_BG), bg);
const NON_GREY = [...CATEGORY_COLORS, C.purple];

describe('the fixed fades keep the signed-off look', () => {
  // [A1] Every non-grey slice colour takes the category fade, the grey takes its own.
  it('[A1] every category colour and the Uncategorized purple fade to 0.55; only the grey gets 0.85', () => {
    for (const color of NON_GREY) expect(wedgeDim(color)).toBe(0.55);
    expect(wedgeDim(OTHER_COLOR)).toBe(0.85);
  });

  // [A2] A faded category keeps at most half its full contrast — it visibly steps back.
  // FAIL-ON-REVERT: WEDGE_DIM = 0.85 leaves bright slices at ~76% of full contrast.
  it('[A2] a faded category slice keeps at most half its full contrast against the track', () => {
    for (const color of NON_GREY) {
      expect(fadedContrast(color) / contrastHex(color, CHART_BG)).toBeLessThanOrEqual(0.5);
    }
  });

  // [A3] The faded grey is no brighter than the brightest faded category: every faded slice reads
  // level. FAIL-ON-REVERT: WEDGE_DIM_OTHER = 1 (grey stops fading) puts it at 3.97 vs 3.56.
  it('[A3] the faded grey "Other" is no brighter than the faded category slices', () => {
    const brightestCategory = Math.max(...NON_GREY.map(fadedContrast));
    expect(fadedContrast(OTHER_COLOR)).toBeLessThanOrEqual(brightestCategory);
    expect(fadedContrast(OTHER_COLOR)).toBeLessThan(contrastHex(OTHER_COLOR, CHART_BG));
  });
});
