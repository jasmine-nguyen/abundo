// WHIT-759 — the unselected pie slices fade to fixed, hand-set values instead of a per-colour
// calculation. Those values must still let every shipped slice colour clear WCAG 1.4.11's 3:1.
// Measured with the independent ./support/wcag maths — never with the code under test.
import { describe, it, expect } from '@jest/globals';
import { CATEGORY_COLORS, OTHER_COLOR, CHART_BG, wedgeDim } from '../chartColors';
import { C } from '../theme';
import { hexToRgb, contrastRatio, fadedOver } from './support/wcag';

const bg = hexToRgb(CHART_BG);
const fadedContrast = (color: string) => contrastRatio(fadedOver(color, wedgeDim(color), CHART_BG), bg);
const NON_GREY = [...CATEGORY_COLORS, C.purple];

describe('the fixed fades keep the signed-off look', () => {
  it('every shipped slice colour still clears 3:1 at its fade', () => {
    for (const color of [...NON_GREY, OTHER_COLOR]) expect(fadedContrast(color)).toBeGreaterThanOrEqual(3);
  });
});
