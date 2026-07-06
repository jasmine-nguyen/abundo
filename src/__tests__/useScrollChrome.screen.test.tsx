// WHIT-184 GAP — useScrollChrome internals the screen tests don't reach:
//   (1) focus-reset: refocusing a screen whose chrome was hidden calls setChrome('shown')
//       so a hidden header/tab bar is never stranded on tab switch / short list.
//   (2) dedup: a continued same-direction scroll doesn't re-call setChrome.
//   (3) headerStyle slide distance == headerHeight and sign is NEGATIVE (slides UP off top),
//       plus opacity tracks visibility. A revert to +headerHeight or a wrong inset flips these.
import { it, expect, jest, beforeEach } from '@jest/globals';
import { Animated } from 'react-native';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { renderHook, act } from '@testing-library/react-native';

// Real Animated.Value shared with the hook, plus a spy setter. `mock`-prefixed so the
// jest.mock factory may reference them (jest hoisting rule).
let mockVisibility: Animated.Value;
const mockSetChrome = jest.fn();
jest.mock('../motion/ChromeContext', () => ({
  useChrome: () => ({ visibility: mockVisibility, setChrome: mockSetChrome }),
}));

// Capture the focus callback so the test can re-fire it (simulate a tab refocus).
let mockFocusCb: (() => void) | undefined;
jest.mock('expo-router', () => {
  const React = require('react');
  return {
    useFocusEffect: (cb: () => void) => {
      mockFocusCb = cb;
      React.useEffect(() => cb(), [cb]);
    },
  };
});

import { useScrollChrome, HEADER_BODY_HEIGHT } from '../motion/useScrollChrome';

beforeEach(() => {
  mockSetChrome.mockClear();
  mockVisibility = new Animated.Value(1);
  mockFocusCb = undefined;
});

function scroll(onScroll: (e: NativeSyntheticEvent<NativeScrollEvent>) => void, y: number) {
  act(() => onScroll({ nativeEvent: { contentOffset: { y } } } as unknown as NativeSyntheticEvent<NativeScrollEvent>));
}

it('HEADER_BODY_HEIGHT is the documented 58 (header body under the safe-area inset)', () => {
  expect(HEADER_BODY_HEIGHT).toBe(58);
});

it('scrollEventThrottle is 16', () => {
  const { result } = renderHook(() => useScrollChrome(120));
  expect(result.current.scrollEventThrottle).toBe(16);
});

it('refocusing after the chrome was hidden resets it to shown', () => {
  const { result } = renderHook(() => useScrollChrome(120));
  scroll(result.current.onScroll, 300);                       // hide
  expect(mockSetChrome).toHaveBeenLastCalledWith('hidden');
  mockSetChrome.mockClear();

  act(() => mockFocusCb && mockFocusCb());    // simulate re-entering the tab
  expect(mockSetChrome).toHaveBeenCalledWith('shown');
});

it('a continued same-direction scroll does not re-call setChrome', () => {
  const { result } = renderHook(() => useScrollChrome(120));
  scroll(result.current.onScroll, 200);                       // shown → hidden (1 call)
  scroll(result.current.onScroll, 400);                       // still going down, already hidden → no new call
  expect(mockSetChrome).toHaveBeenCalledTimes(1);
  expect(mockSetChrome).toHaveBeenLastCalledWith('hidden');
});

it('headerStyle slides the header UP by exactly headerHeight when hidden, and opacity tracks visibility', () => {
  const { result } = renderHook(() => useScrollChrome(120));
  const translateY = result.current.headerStyle.transform[0].translateY as unknown as { __getValue(): number };

  // visibility 1 (shown) → no offset; opacity is the visibility node itself.
  expect(translateY.__getValue()).toBe(0);
  expect(result.current.headerStyle.opacity).toBe(mockVisibility);

  act(() => mockVisibility.setValue(0));      // hidden
  expect(translateY.__getValue()).toBe(-120); // slid fully off the top by its height (negative)
});
