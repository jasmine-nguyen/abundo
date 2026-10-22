// ABU-110 — the wide (two-pane) layout turns on from 600pt of window width, never on the web
// (where the app is framed phone-sized).
import { describe, it, expect, jest } from '@jest/globals';

let mockWidth = 390;
let mockOS = 'ios';
jest.mock('react-native', () => ({
  useWindowDimensions: () => ({ width: mockWidth, height: 900, fontScale: 1, scale: 3 }),
  Platform: { get OS() { return mockOS; } },
}));

import { useWideLayout } from '../hooks/useWideLayout';

describe('useWideLayout', () => {
  it.each([
    ['ios', 440, false],
    ['ios', 599, false],
    ['ios', 600, true],
    ['ios', 669, true],
    ['web', 1200, false],
  ])('%s at %ppt wide → %p', (os, width, expected) => {
    mockOS = os;
    mockWidth = width;
    expect(useWideLayout()).toBe(expected);
  });
});
