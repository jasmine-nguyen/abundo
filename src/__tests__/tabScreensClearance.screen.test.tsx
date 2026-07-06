// WHIT-200 GAP — the three UNWIRED tab screens (Goals / Insights / Settings) had their
// hard-coded `paddingBottom: 120` replaced by the shared TAB_BAR_CLEARANCE constant. The
// implementer's motion tests only assert this for Transactions/Budgets (the wired screens).
// This is the fail-on-revert guard for the DRY on the other three.
//
// Fail-on-revert is REAL here: TAB_BAR_CLEARANCE is mocked to a SENTINEL (999), not its
// production value (120). So a screen that reverts to a literal `paddingBottom: 120` reads
// 120 !== 999 and this flips — a guard that would silently pass if we asserted === 120.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { ScrollView } from 'react-native';
import { render } from '@testing-library/react-native';
import type { AppContext } from '../context';
import { makeState } from './factory';

const SENTINEL = 999;
jest.mock('../motion/useNavBarsHeader', () => ({ TAB_BAR_CLEARANCE: 999 }));

// Real selectors (goalView/categoryBreakdown/aiGoalSignal/…), controlled state.
let mockState: AppContext;
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});

// Query-fed rows for Insights/Settings — minimal loaded shapes so each ScrollView renders.
const category = (_id: string | null) => undefined;
jest.mock('../queries', () => ({
  // WHIT-197: Goals reads from the query layer. All-null/empty facts → the "set up" state renders.
  useGoalScreenData: () => ({
    loanFacts: { original: null, homeValue: null, lvr: null, ratePct: null, baseRepay: null, extra: null },
    homeLoan: { balance: null, asOf: null },
    repayment: { amount: null, date: null, principal: null, interest: null },
    refetchStale: jest.fn(),
  }),
  useInsightsScreenData: () => ({ breakdown: {}, category, isLoading: false, isError: false, refetch: jest.fn(), refetchStale: jest.fn() }),
  useSettingsScreenData: () => ({ categoriesCount: 12, loanReady: true, isLoading: false, refetchStale: jest.fn() }),
  useRulesScreenData: () => ({ rules: [], isLoading: false, isError: false, refetch: jest.fn(), refetchStale: jest.fn() }),
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

import Goals from '../../app/(tabs)/goals';
import Insights from '../../app/(tabs)/insights';
import Settings from '../../app/(tabs)/settings';

beforeEach(() => {
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

function bottomPaddingOf(ui: React.ReactElement): number {
  const { UNSAFE_getAllByType } = render(ui);
  const sv = UNSAFE_getAllByType(ScrollView)[0] as unknown as { props: { contentContainerStyle: { paddingBottom: number } } };
  return sv.props.contentContainerStyle.paddingBottom;
}

describe('unwired tab screens use the shared TAB_BAR_CLEARANCE, not a literal 120', () => {
  it('Goals list bottom inset comes from TAB_BAR_CLEARANCE', () => {
    expect(bottomPaddingOf(<Goals />)).toBe(SENTINEL);
  });
  it('Insights list bottom inset comes from TAB_BAR_CLEARANCE', () => {
    expect(bottomPaddingOf(<Insights />)).toBe(SENTINEL);
  });
  it('Settings list bottom inset comes from TAB_BAR_CLEARANCE', () => {
    expect(bottomPaddingOf(<Settings />)).toBe(SENTINEL);
  });
});
