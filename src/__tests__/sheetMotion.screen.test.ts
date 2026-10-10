// WHIT-199 — the sheet open-spring reduce-motion gate (screen project, RN preset). Mirrors the applyVisibility test:
// reduce-motion jumps the value instantly (no spring frames); otherwise a spring is started.
// Pure helper so the gate is testable without a mounted Modal (native-driver values don't
// advance in jest, so a "did it animate" test would be a no-op — this asserts the BRANCH).
import { describe, it, expect, jest } from '@jest/globals';
import { Animated } from 'react-native';
import { springSheetIn, SHEET_ENTER_OFFSET } from '../motion/sheetMotion';

describe('springSheetIn', () => {
  it('reduce-motion: jumps straight to the resting position, no spring started', () => {
    const value = new Animated.Value(SHEET_ENTER_OFFSET);
    const springSpy = jest.spyOn(Animated, 'spring');
    springSheetIn(value, true);
    // @ts-expect-error __getValue is an internal test-only accessor on Animated.Value
    expect(value.__getValue()).toBe(0);
    expect(springSpy).not.toHaveBeenCalled();
    springSpy.mockRestore();
  });
});
