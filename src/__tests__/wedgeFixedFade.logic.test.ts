// WHIT-759 — the unselected pie slices fade to fixed, hand-set values instead of a per-colour
// calculation. These values must still let every shipped slice colour clear WCAG 1.4.11's 3:1
// against the ring track. Measured with the independent hand-written
// maths in ./support/wcag — never with the code under test.
import { describe, it, expect } from '@jest/globals';
import { CATEGORY_COLORS, OTHER_COLOR, CHART_BG, wedgeDim } from '../chartColors';
import { C } from '../theme';
import { hexToRgb, contrastRatio, fadedOver } from './support/wcag';

const WEDGE_COLORS = [...CATEGORY_COLORS, OTHER_COLOR, C.purple];

describe('unselected pie slices use fixed fades', () => {
  it('every shipped slice colour still clears 3:1 at its fade', () => {
    const bg = hexToRgb(CHART_BG);
    for (const color of WEDGE_COLORS) {
      expect(contrastRatio(fadedOver(color, wedgeDim(color), CHART_BG), bg)).toBeGreaterThanOrEqual(3);
    }
  });
});
