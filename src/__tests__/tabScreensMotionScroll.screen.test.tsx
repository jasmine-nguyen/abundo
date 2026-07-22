// WHIT-199 GAP — the scroll-to-hide wiring now extended to Insights / Goals / Settings via
// the shared ScrollChromeHeader wrapper. budgetsMotionScroll/motionScroll lock Budgets +
// Transactions; this locks the three newly-wired screens: down → 'hidden', up → 'shown',
// jitter no-op, throttle 16, animated header present. Uses the REAL useNavBarsHeader (so the
// wrapper's onScroll wiring is exercised) and spies the shared setNavBars. Fail-on-revert:
// drop the ScrollChromeHeader wrapper on any of the three (back to a static header) and its
// 'hidden' assert flips (no onScroll → setNavBars never called).
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { ScrollView, Animated } from 'react-native';
import { render } from '@testing-library/react-native';
import type { AppContext } from '../context';
import { makeState } from './factory';

// Real selectors, controlled state (mirrors tabScreensClearance's setup).
let mockState: AppContext;
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});

const category = (_id: string | null) => undefined;
jest.mock('../queries', () => ({
  // WHIT-233: the Goals tab is now the hub (useGoalsScreenData). Empty goals still render the
  // ScrollChromeHeader-wrapped ScrollView this suite scrolls to exercise the hide/show wiring.
  useGoalsScreenData: () => ({
    goals: [],
    payCycle: { length: 14, last_pay_date: '2024-01-03' },
    balanceFor: () => null,
    loanFacts: { original: null, homeValue: null, lvr: null, ratePct: null, baseRepay: null, extra: null },
    homeLoan: { balance: null, asOf: null },
    mortgageError: false,
    isLoading: false, isError: false,
    refetch: jest.fn(), refetchStale: jest.fn(),
  }),
  // Insights (also rendered below) still reads the mortgage composite for its aiGoalSignal.
  useGoalScreenData: () => ({
    loanFacts: { original: null, homeValue: null, lvr: null, ratePct: null, baseRepay: null, extra: null },
    homeLoan: { balance: null, asOf: null },
    repayment: { amount: null, date: null, principal: null, interest: null },
    homeLoanError: false, repaymentError: false, refetchStale: jest.fn(),
  }),
  useInsightsScreenData: () => ({ breakdown: {}, earned: 0, category, isLoading: false, isError: false, refetch: jest.fn(), refetchStale: jest.fn() }),
  useSettingsScreenData: () => ({ categoriesCount: 12, loanReady: true, isLoading: false, refetchStale: jest.fn() }),
  useRulesScreenData: () => ({ rules: [], isLoading: false, isError: false, rulesError: false, refetch: jest.fn(), refetchStale: jest.fn() }),
  usePayCycle: () => ({ payCycle: { length: 14, last_pay_date: '2024-01-03' }, cycleLen: 14, daysLeft: 7, cycleName: () => 'Fortnightly', isLoading: false, isError: false }),
}));

jest.mock('../auth', () => ({ getCurrentUser: () => null, signOut: jest.fn() }));

jest.mock('expo-router', () => {
  const React2 = require('react');
  return {
    useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
    useFocusEffect: (cb: () => void) => React2.useEffect(() => cb(), [cb]),
  };
});

// Spy the shared setter; real Animated.Value (header style builds) + the single stateRef the
// hook writes, so its dedup/direction runs against the shared source of truth.
let mockStateRef: { current: 'shown' | 'hidden' } = { current: 'shown' };
const mockSetNavBars = jest.fn((n: 'shown' | 'hidden') => { mockStateRef.current = n; });
jest.mock('../motion/NavBarsContext', () => {
  const { Animated: RNAnimated } = require('react-native');
  return { useNavBars: () => ({ visibility: new RNAnimated.Value(1), setNavBars: mockSetNavBars, stateRef: mockStateRef }) };
});

import Goals from '../../app/(tabs)/goals';
import Insights from '../../app/(tabs)/insights';
import Settings from '../../app/(tabs)/settings';

beforeEach(() => {
  mockSetNavBars.mockClear();
  mockStateRef = { current: 'shown' };
  mockState = {
    ...makeState(),
    fireRepayment: jest.fn(),
    refreshAiInsights: jest.fn(),
    aiInsights: null,
    aiInsightsError: false,
    aiInsightsLoading: false,
    rules: [],
    setSheet: jest.fn(),
  } as unknown as AppContext;
});

function scrollTo(sv: { props: { onScroll: (e: unknown) => void } }, y: number) {
  sv.props.onScroll({ nativeEvent: { contentOffset: { y } } });
}
function firstScrollView(ui: React.ReactElement) {
  const { UNSAFE_getAllByType } = render(ui);
  return {
    sv: UNSAFE_getAllByType(ScrollView)[0] as unknown as { props: { onScroll: (e: unknown) => void; scrollEventThrottle: number } },
    animatedHeaders: UNSAFE_getAllByType(Animated.View).length,
  };
}

const SCREENS: [string, React.ReactElement][] = [
  ['Goals', <Goals />],
  ['Insights', <Insights />],
  ['Settings', <Settings />],
];

describe.each(SCREENS)('scroll-to-hide is wired on %s (WHIT-199)', (_name, ui) => {
  it('scrolling down hides the nav bars, scrolling back up shows it', () => {
    const { sv } = firstScrollView(ui);
    scrollTo(sv, 120); // down past threshold, out of the top zone
    expect(mockSetNavBars).toHaveBeenLastCalledWith('hidden');
    scrollTo(sv, 20); // back up
    expect(mockSetNavBars).toHaveBeenLastCalledWith('shown');
  });

  it('a tiny jitter scroll near the top does not toggle the nav bars', () => {
    const { sv } = firstScrollView(ui);
    scrollTo(sv, 3);
    expect(mockSetNavBars).not.toHaveBeenCalled();
  });

  it('exposes scrollEventThrottle=16 and renders an Animated.View header', () => {
    const { sv, animatedHeaders } = firstScrollView(ui);
    expect(sv.props.scrollEventThrottle).toBe(16);
    expect(animatedHeaders).toBeGreaterThan(0);
  });
});
