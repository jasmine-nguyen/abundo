// WHIT-759 — the unselected pie slices fade to fixed, hand-set values instead of a per-colour
// calculation. These values must still let every shipped slice colour clear WCAG 1.4.11's 3:1
// against the ring track, and must still actually fade. Measured with the independent hand-written
// maths in ./support/wcag — never with the code under test.
import { describe, it, expect } from '@jest/globals';
import { CATEGORY_COLORS, OTHER_COLOR, CHART_BG, WEDGE_DIM, WEDGE_DIM_OTHER, wedgeDim } from '../chartColors';
import { C } from '../theme';
import { hexToRgb, contrastRatio, fadedOver } from './support/wcag';

const WEDGE_COLORS = [...CATEGORY_COLORS, OTHER_COLOR, C.purple];

describe('unselected pie slices use fixed fades', () => {
  it('category slices fade to 0.55 and the grey "Other" slice to 0.85', () => {
    expect(WEDGE_DIM).toBe(0.55);
    expect(WEDGE_DIM_OTHER).toBe(0.85);
    expect(wedgeDim(OTHER_COLOR)).toBe(0.85);
    expect(wedgeDim(CATEGORY_COLORS[0])).toBe(0.55);
    expect(wedgeDim(C.purple)).toBe(0.55);
    expect(wedgeDim('')).toBe(0.55);
  });

  it('every shipped slice colour still clears 3:1 at its fade, and the fade still fades', () => {
    const bg = hexToRgb(CHART_BG);
    for (const color of WEDGE_COLORS) {
      expect(contrastRatio(fadedOver(color, wedgeDim(color), CHART_BG), bg)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(fadedOver(color, 0.4, CHART_BG), bg)).toBeLessThan(3); // the old flat fade
    }
    expect(WEDGE_DIM).toBeLessThan(0.9);
    expect(WEDGE_DIM_OTHER).toBeLessThan(1);
  });
});
