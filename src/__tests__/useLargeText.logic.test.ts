// WHIT-743 — the large-text switch flips between iOS XXXL (1.35) and the first accessibility size.
import { describe, it, expect, jest } from '@jest/globals';

let mockFontScale = 1;
jest.mock('react-native', () => ({ useWindowDimensions: () => ({ fontScale: mockFontScale }) }));

import { useLargeText } from '../hooks/useLargeText';

describe('useLargeText', () => {
  it.each([
    [1, false],
    [1.35, false],
    [1.5, true],
    [3.12, true],
  ])('fontScale %p → %p', (fontScale, expected) => {
    mockFontScale = fontScale;
    expect(useLargeText()).toBe(expected);
  });
});
