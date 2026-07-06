// WHIT-184/200 — wires the pure state machine to the real Transactions screen: a downward
// scroll drives the nav bars to 'hidden', an upward scroll back to 'shown'. We spy the
// context's setNavBars (and give it the shared stateRef it writes) rather than read the
// animated transform — with useNativeDriver the JS-side value doesn't update in jest, so
// asserting the transform would be flaky. Also locks the screen's list geometry to the
// shared constants (the DRY the refactor introduced).
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { ScrollView, Animated } from 'react-native';
import { render } from '@testing-library/react-native';
import type { AppContext } from '../context';
import { HEADER_BODY_HEIGHT, TAB_BAR_CLEARANCE } from '../motion/useNavBarsHeader';

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

// Spy the shared setter; give it a real Animated.Value (so the header style builds) and
// the single stateRef it writes (so the hook's dedup/direction runs against it).
// `mock`-prefixed so the jest.mock factory may reference them (jest hoisting rule).
let mockStateRef: { current: 'shown' | 'hidden' } = { current: 'shown' };
const mockSetNavBars = jest.fn((n: 'shown' | 'hidden') => { mockStateRef.current = n; });
jest.mock('../motion/NavBarsContext', () => {
  const { Animated: RNAnimated } = require('react-native');
  return { useNavBars: () => ({ visibility: new RNAnimated.Value(1), setNavBars: mockSetNavBars, stateRef: mockStateRef }) };
});

import Transactions from '../../app/(tabs)/transactions';

const category = () => undefined;

beforeEach(() => {
  mockSetNavBars.mockClear();
  mockStateRef = { current: 'shown' };
  mockTx = { transactions: [], category, isLoading: false, isError: false, isFetching: false, refetch: jest.fn(), refetchStale: jest.fn() };
  mockState = { retryLoad: jest.fn(), category } as unknown as AppContext;
});

function scrollTo(sv: { props: { onScroll: (e: unknown) => void } }, y: number) {
  sv.props.onScroll({ nativeEvent: { contentOffset: { y } } });
}

it('scrolling down hides the nav bars, scrolling back up shows them', () => {
  const { UNSAFE_getAllByType } = render(<Transactions />);
  const sv = UNSAFE_getAllByType(ScrollView)[0] as unknown as { props: { onScroll: (e: unknown) => void } };

  scrollTo(sv, 120);                       // down past threshold, out of the top zone
  expect(mockSetNavBars).toHaveBeenLastCalledWith('hidden');

  scrollTo(sv, 20);                        // back up
  expect(mockSetNavBars).toHaveBeenLastCalledWith('shown');
});

it('a tiny jitter scroll near the top does not toggle the nav bars', () => {
  const { UNSAFE_getAllByType } = render(<Transactions />);
  const sv = UNSAFE_getAllByType(ScrollView)[0] as unknown as { props: { onScroll: (e: unknown) => void } };
  // y within the top zone → stays shown; state was already shown, so no setNavBars call.
  scrollTo(sv, 3);
  expect(mockSetNavBars).not.toHaveBeenCalled();
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

// Behavioural geometry (replaces the old HEADER_BODY_HEIGHT===58 literal): the list's top
// inset equals the header height and its bottom inset equals the tab-bar clearance — with
// safe-area insets mocked to 0, top === HEADER_BODY_HEIGHT. (The DRY — that the 3 unwired
// screens use the shared constant, not a literal 120 — is locked separately, with a
// sentinel value, in tabScreensClearance.screen.test.tsx.)
it('insets the list by the shared header height (top) and tab-bar clearance (bottom)', () => {
  const { UNSAFE_getAllByType } = render(<Transactions />);
  const sv = UNSAFE_getAllByType(ScrollView)[0] as unknown as { props: { contentContainerStyle: { paddingTop: number; paddingBottom: number } } };
  expect(sv.props.contentContainerStyle.paddingTop).toBe(HEADER_BODY_HEIGHT); // insets.top (0 in tests) + HEADER_BODY_HEIGHT
  expect(sv.props.contentContainerStyle.paddingBottom).toBe(TAB_BAR_CLEARANCE);
});
