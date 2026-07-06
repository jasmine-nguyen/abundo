// WHIT-184 — wires the pure state machine to the real Transactions screen: a downward
// scroll drives chrome to 'hidden', an upward scroll back to 'shown'. We spy the
// context's setChrome rather than read the animated transform — with useNativeDriver
// the JS-side value doesn't update in jest, so asserting the transform would be flaky.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { ScrollView, Animated } from 'react-native';
import { render } from '@testing-library/react-native';
import type { AppContext } from '../context';

let mockTx: { transactions: unknown[]; category: (id: string | null) => unknown; isLoading: boolean; isError: boolean; isFetching: boolean; refetch: jest.Mock; refetchStale: jest.Mock };
jest.mock('../queries', () => ({ useTransactionsScreenData: () => mockTx }));

let mockState: AppContext;
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});

jest.mock('expo-router', () => {
  const React2 = require('react');
  return { useFocusEffect: (cb: () => void) => React2.useEffect(() => cb(), [cb]) };
});

// Spy the shared chrome setter; give it a real Animated.Value so the header style builds.
// `mock`-prefixed so the jest.mock factory may reference it (jest hoisting rule).
const mockSetChrome = jest.fn();
jest.mock('../motion/ChromeContext', () => {
  const { Animated: RNAnimated } = require('react-native');
  return { useChrome: () => ({ visibility: new RNAnimated.Value(1), setChrome: mockSetChrome }) };
});

import Transactions from '../../app/(tabs)/transactions';

const category = () => undefined;

beforeEach(() => {
  mockSetChrome.mockClear();
  mockTx = { transactions: [], category, isLoading: false, isError: false, isFetching: false, refetch: jest.fn(), refetchStale: jest.fn() };
  mockState = { retryLoad: jest.fn(), category } as unknown as AppContext;
});

function scrollTo(sv: { props: { onScroll: (e: unknown) => void } }, y: number) {
  sv.props.onScroll({ nativeEvent: { contentOffset: { y } } });
}

it('scrolling down hides the chrome, scrolling back up shows it', () => {
  const { UNSAFE_getAllByType } = render(<Transactions />);
  const sv = UNSAFE_getAllByType(ScrollView)[0] as unknown as { props: { onScroll: (e: unknown) => void } };

  scrollTo(sv, 120);                       // down past threshold, out of the top zone
  expect(mockSetChrome).toHaveBeenLastCalledWith('hidden');

  scrollTo(sv, 20);                        // back up
  expect(mockSetChrome).toHaveBeenLastCalledWith('shown');
});

it('a tiny jitter scroll near the top does not toggle the chrome', () => {
  const { UNSAFE_getAllByType } = render(<Transactions />);
  const sv = UNSAFE_getAllByType(ScrollView)[0] as unknown as { props: { onScroll: (e: unknown) => void } };
  // y within the top zone → stays shown; state was already shown, so no setChrome call.
  scrollTo(sv, 3);
  expect(mockSetChrome).not.toHaveBeenCalled();
});

it('exposes scrollEventThrottle so onScroll actually fires while dragging', () => {
  const { UNSAFE_getAllByType } = render(<Transactions />);
  const sv = UNSAFE_getAllByType(ScrollView)[0] as unknown as { props: { scrollEventThrottle: number } };
  expect(sv.props.scrollEventThrottle).toBe(16);
});

// Guard: the screen must render with the animated header present (Animated.View swap).
it('renders the animated header', () => {
  const { UNSAFE_getAllByType } = render(<Transactions />);
  expect(UNSAFE_getAllByType(Animated.View).length).toBeGreaterThan(0);
});
