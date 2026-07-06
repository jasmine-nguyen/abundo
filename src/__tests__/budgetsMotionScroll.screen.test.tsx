// WHIT-184/200 GAP — the scroll-to-hide wiring on the BUDGETS screen. motionScroll.screen
// only exercises Transactions; Budgets has its own useNavBarsHeader() call and could be
// reverted (drop onScroll / scrollEventThrottle) with the Transactions test still green.
// This locks: down → 'hidden', up → 'shown', jitter no-op, throttle 16, animated header
// present. Fail-on-revert: unwire onScroll on budgets.tsx and the first assert flips.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { ScrollView, Animated } from 'react-native';
import { render } from '@testing-library/react-native';

// Budgets is query-fed; return the minimal shape useBudgetsScreenData exposes with NO rows
// so the screen skips the spinner/error and renders the ScrollView (rows empty → onScroll live).
const category = (_id: string | null) => undefined;
let mockBudgets: {
  budgets: unknown[]; category: typeof category; cycleLen: number; daysLeft: number;
  isLoading: boolean; isError: boolean; refetch: jest.Mock; refetchStale: jest.Mock;
};
jest.mock('../queries', () => ({ useBudgetsScreenData: () => mockBudgets }));

jest.mock('expo-router', () => {
  const React2 = require('react');
  return {
    useRouter: () => ({ push: jest.fn() }),
    useFocusEffect: (cb: () => void) => React2.useEffect(() => cb(), [cb]),
  };
});

// Spy the shared setter; give it a real Animated.Value (header style builds) + the single
// stateRef it writes (so the hook's dedup/direction runs against the shared source of truth).
let mockStateRef: { current: 'shown' | 'hidden' } = { current: 'shown' };
const mockSetNavBars = jest.fn((n: 'shown' | 'hidden') => { mockStateRef.current = n; });
jest.mock('../motion/NavBarsContext', () => {
  const { Animated: RNAnimated } = require('react-native');
  return { useNavBars: () => ({ visibility: new RNAnimated.Value(1), setNavBars: mockSetNavBars, stateRef: mockStateRef }) };
});

import Budgets from '../../app/(tabs)/budgets';

beforeEach(() => {
  mockSetNavBars.mockClear();
  mockStateRef = { current: 'shown' };
  mockBudgets = {
    budgets: [], category, cycleLen: 14, daysLeft: 7,
    isLoading: false, isError: false, refetch: jest.fn(), refetchStale: jest.fn(),
  };
});

function scrollTo(sv: { props: { onScroll: (e: unknown) => void } }, y: number) {
  sv.props.onScroll({ nativeEvent: { contentOffset: { y } } });
}

it('budgets: scrolling down hides the nav bars, scrolling back up shows it', () => {
  const { UNSAFE_getAllByType } = render(<Budgets />);
  const sv = UNSAFE_getAllByType(ScrollView)[0] as unknown as { props: { onScroll: (e: unknown) => void } };

  scrollTo(sv, 120); // down past threshold, out of the top zone
  expect(mockSetNavBars).toHaveBeenLastCalledWith('hidden');

  scrollTo(sv, 20); // back up
  expect(mockSetNavBars).toHaveBeenLastCalledWith('shown');
});

it('budgets: a tiny jitter scroll near the top does not toggle the nav bars', () => {
  const { UNSAFE_getAllByType } = render(<Budgets />);
  const sv = UNSAFE_getAllByType(ScrollView)[0] as unknown as { props: { onScroll: (e: unknown) => void } };
  scrollTo(sv, 3); // inside the top zone, already shown → no call
  expect(mockSetNavBars).not.toHaveBeenCalled();
});

it('budgets: exposes scrollEventThrottle=16 so onScroll fires while dragging', () => {
  const { UNSAFE_getAllByType } = render(<Budgets />);
  const sv = UNSAFE_getAllByType(ScrollView)[0] as unknown as { props: { scrollEventThrottle: number } };
  expect(sv.props.scrollEventThrottle).toBe(16);
});

it('budgets: renders the animated (Animated.View) header', () => {
  const { UNSAFE_getAllByType } = render(<Budgets />);
  expect(UNSAFE_getAllByType(Animated.View).length).toBeGreaterThan(0);
});
