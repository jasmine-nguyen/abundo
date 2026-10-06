// WHIT-759 — the unselected pie slices fade to fixed, hand-set values instead of a per-colour
// calculation. Those values must still let every shipped slice colour clear WCAG 1.4.11's 3:1,
// and keep the look Jas signed off on (option B): a faded category slice CLEARLY steps back, and
// the faded grey "Other" ends up level with the faded categories, not brighter. Measured with the
// independent ./support/wcag maths — never with the code under test.
import { describe, it, expect } from '@jest/globals';
import { CATEGORY_COLORS, OTHER_COLOR, CHART_BG, wedgeDim } from '../chartColors';
import { C } from '../theme';
import { hexToRgb, contrastRatio, contrastHex, fadedOver } from './support/wcag';

const bg = hexToRgb(CHART_BG);
const fadedContrast = (color: string) => contrastRatio(fadedOver(color, wedgeDim(color), CHART_BG), bg);
const NON_GREY = [...CATEGORY_COLORS, C.purple];

describe('the fixed fades keep the signed-off look', () => {
  it('every shipped slice colour still clears 3:1 at its fade', () => {
    for (const color of [...NON_GREY, OTHER_COLOR]) expect(fadedContrast(color)).toBeGreaterThanOrEqual(3);
  });

  // [A2] A faded category keeps at most half its full contrast — it visibly steps back.
  // FAIL-ON-REVERT: a 0.85 category fade leaves bright slices at ~76% of full contrast.
  it('[A2] a faded category slice keeps at most half its full contrast against the track', () => {
    for (const color of NON_GREY) {
      expect(fadedContrast(color) / contrastHex(color, CHART_BG)).toBeLessThanOrEqual(0.5);
    }
  });

  // [A3] The faded grey is no brighter than the brightest faded category: every faded slice reads
  // level. FAIL-ON-REVERT: a grey fade of 1 (grey stops fading) puts it at 3.97 vs 3.56.
  it('[A3] the faded grey "Other" is no brighter than the faded category slices', () => {
    const brightestCategory = Math.max(...NON_GREY.map(fadedContrast));
    expect(fadedContrast(OTHER_COLOR)).toBeLessThanOrEqual(brightestCategory);
    expect(fadedContrast(OTHER_COLOR)).toBeLessThan(contrastHex(OTHER_COLOR, CHART_BG));
  });
});
