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

  it('motion on: starts a spring toward the resting position (0)', () => {
    const value = new Animated.Value(SHEET_ENTER_OFFSET);
    const started = jest.fn();
    const springSpy = jest.spyOn(Animated, 'spring').mockReturnValue({ start: started } as unknown as Animated.CompositeAnimation);
    springSheetIn(value, false);
    expect(springSpy).toHaveBeenCalledTimes(1);
    const [target, config] = springSpy.mock.calls[0];
    expect(target).toBe(value);
    expect((config as { toValue: number }).toValue).toBe(0);
    expect((config as { useNativeDriver: boolean }).useNativeDriver).toBe(true);
    expect(started).toHaveBeenCalledTimes(1);
    springSpy.mockRestore();
  });

  it('SHEET_ENTER_OFFSET is a positive rise distance', () => {
    expect(SHEET_ENTER_OFFSET).toBeGreaterThan(0);
  });
});
