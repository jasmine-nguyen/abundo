// WHIT-200 — useScrollNavBars: the scroll→state wiring. State lives in the provider now,
// so the hook reads/writes the shared stateRef via useNavBars; it keeps no chrome state
// of its own and no longer resets on focus (that moved to NavBarsRouteReset). Covers:
//   (1) direction: down → 'hidden', a later up → 'shown' (proves it reads+writes the shared ref),
//   (2) dedup: a continued same-direction scroll doesn't re-call setNavBars,
//   (3) headerStyle slide distance == headerHeight, sign NEGATIVE (slides UP off top), opacity tracks visibility.
import { it, expect, jest, beforeEach } from '@jest/globals';
import { Animated } from 'react-native';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { renderHook, act } from '@testing-library/react-native';

// The mocked context exposes the SAME single stateRef the provider owns; setNavBars must
// write it, so the hook's dedup/direction logic runs against the shared source of truth.
let mockVisibility: Animated.Value;
let mockStateRef: { current: 'shown' | 'hidden' };
const mockSetNavBars = jest.fn((n: 'shown' | 'hidden') => { mockStateRef.current = n; });
jest.mock('../motion/NavBarsContext', () => ({
  useNavBars: () => ({ visibility: mockVisibility, setNavBars: mockSetNavBars, stateRef: mockStateRef }),
}));

import { useScrollNavBars } from '../motion/useScrollNavBars';

beforeEach(() => {
  mockSetNavBars.mockClear();
  mockVisibility = new Animated.Value(1);
  mockStateRef = { current: 'shown' };
});

function scroll(onScroll: (e: NativeSyntheticEvent<NativeScrollEvent>) => void, y: number) {
  act(() => onScroll({ nativeEvent: { contentOffset: { y } } } as unknown as NativeSyntheticEvent<NativeScrollEvent>));
}

it('scrollEventThrottle is 16', () => {
  const { result } = renderHook(() => useScrollNavBars(120));
  expect(result.current.scrollEventThrottle).toBe(16);
});

it('scrolling down hides, then scrolling up shows — driving the shared stateRef', () => {
  const { result } = renderHook(() => useScrollNavBars(120));
  scroll(result.current.onScroll, 200);
  expect(mockSetNavBars).toHaveBeenLastCalledWith('hidden');
  scroll(result.current.onScroll, 20);
  expect(mockSetNavBars).toHaveBeenLastCalledWith('shown');
});

it('a continued same-direction scroll does not re-call setNavBars (dedups on the shared ref)', () => {
  const { result } = renderHook(() => useScrollNavBars(120));
  scroll(result.current.onScroll, 200);   // shown → hidden (1 call, ref now 'hidden')
  scroll(result.current.onScroll, 400);   // still down, already hidden → no new call
  expect(mockSetNavBars).toHaveBeenCalledTimes(1);
  expect(mockSetNavBars).toHaveBeenLastCalledWith('hidden');
});

it('headerStyle slides the header UP by exactly headerHeight when hidden, and opacity tracks visibility', () => {
  const { result } = renderHook(() => useScrollNavBars(120));
  const translateY = result.current.headerStyle.transform[0].translateY as unknown as { __getValue(): number };

  expect(translateY.__getValue()).toBe(0);                 // visibility 1 (shown) → no offset
  expect(result.current.headerStyle.opacity).toBe(mockVisibility);

  act(() => mockVisibility.setValue(0));                    // hidden
  expect(translateY.__getValue()).toBe(-120);              // slid fully off the top by its height (negative)
});
