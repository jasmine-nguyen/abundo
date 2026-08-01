// The donut's temperature() folds any colour with HSL saturation < 0.25 into the neutral bucket
// reserved for the grey "Other" slice. If a chart-palette colour ever dipped under that, it would be
// mis-classified as "Other" and mis-placed in the ring. This locks that none of the 20 ramp colours
// reads as neutral, and that the reserved OTHER grey correctly does.
import { describe, it, expect } from '@jest/globals';
import { temperature } from '../components/SpendingDonut';
import { CATEGORY_COLORS, OTHER_COLOR } from '../theme/chartColors';

describe('chart palette vs the donut neutral cutoff', () => {
  it('classifies every one of the 20 ramp colours as warm or cool, never neutral', () => {
    for (const hex of CATEGORY_COLORS) {
      expect(temperature(hex)).not.toBe('neutral');
    }
  });

  it('classifies the reserved OTHER grey as neutral (so it stays the "Other" slice)', () => {
    expect(temperature(OTHER_COLOR)).toBe('neutral');
  });
});
