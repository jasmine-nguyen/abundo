// WHIT-495 — the Settings tab became a header gear (top-left) on all five tabs, pushing the
// /settings route. This locks three things the DoD demands:
//   1. The gear is an accessible "Settings" button with a 44x44 touch area, and tapping it
//      navigates to /settings.
//   2. In the shared header the gear renders BEFORE the title (so it's first in the VoiceOver
//      focus order and reads as an action, not part of the title).
//   3. The gear is actually present on ALL FIVE remaining tabs — so a dropped `left` prop on any
//      one screen fails here rather than shipping silently.
import { it, expect, jest, describe, beforeEach } from '@jest/globals';
import React from 'react';
import { Text } from 'react-native';
import { render, screen, fireEvent } from '@testing-library/react-native';

const mockPush = jest.fn();
jest.mock('expo-router', () => {
  const React2 = require('react');
  return {
    useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn() }),
    useFocusEffect: (cb: () => void) => React2.useEffect(() => cb(), [cb]),
  };
});

// Real ScrollChromeHeader, but stub its geometry hook so it renders without a NavBarsProvider
// (mirrors tabScreensClearance). The header still renders left → title → right in JSX order.
jest.mock('../motion/useNavBarsHeader', () => ({
  HEADER_BODY_HEIGHT: 58,
  TAB_BAR_CLEARANCE: 120,
  floatingHeaderStyle: {},
  useNavBarsHeader: () => ({
    onScroll: jest.fn(), scrollEventThrottle: 16, headerStyle: {},
    headerHeight: 58, headerPaddingTop: 6, contentPadding: { paddingTop: 58, paddingBottom: 120 },
  }),
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

const category = (_id: string | null) => undefined;
jest.mock('../queries', () => ({
  useBudgetsScreenData: () => ({ budgets: [], category, cycleLen: 14, daysLeft: 7, isLoading: false, isError: false, refetch: jest.fn(), refetchStale: jest.fn() }),
  useTransactionsScreenData: () => ({
    transactions: [], category, balances: new Map(), isLoading: false, isError: false,
    refetch: jest.fn(), refetchStale: jest.fn(), refetchList: jest.fn(() => Promise.resolve()),
    refreshLiveBalances: jest.fn(() => Promise.resolve()), hasMore: false, loadMore: jest.fn(), isLoadingMore: false,
  }),
  // WHIT-501: no uncategorized charges in these fixtures — the server tally is 0, matching the empty list.
  useUncategorizedCount: () => 0,
  useUncategorizedMerchants: () => ({ merchants: undefined, isLoading: false, isError: false }),
  useInsightsScreenData: () => ({ breakdown: {}, earned: 0, incomeSources: [], category, isLoading: false, isError: false, categoriesError: false, refetch: jest.fn(), refetchStale: jest.fn() }),
  useGoalsScreenData: () => ({
    goals: [], payCycle: { length: 14, last_pay_date: '2024-01-03' }, balanceFor: () => null,
    loanFacts: { original: null, homeValue: null, lvr: null, ratePct: null, baseRepay: null, extra: null },
    homeLoan: { balance: null, asOf: null }, mortgageError: false, isLoading: false, isError: false,
    refetch: jest.fn(), refetchStale: jest.fn(),
  }),
  useGoalScreenData: () => ({
    loanFacts: { original: null, homeValue: null, lvr: null, ratePct: null, baseRepay: null, extra: null },
    homeLoan: { balance: null, asOf: null }, repayment: { amount: null, date: null, principal: null, interest: null },
    refetchStale: jest.fn(),
  }),
}));

// Real selectors (budgetViews / transactionGroups / accountSummaries / categoryBreakdown / …),
// benign useAppContext covering every slice the five screens read.
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return {
    ...actual,
    useAppContext: () => ({
      openMultiPicker: jest.fn(), showToast: jest.fn(), openGoalBalance: jest.fn(),
      setSheet: jest.fn(), rules: [], cycleName: () => 'Fortnightly',
      aiInsights: null, aiInsightsError: false, aiInsightsLoading: false, refreshAiInsights: jest.fn(),
    }),
  };
});

import { SettingsButton } from '../components/SettingsButton';
import { ScrollChromeHeader } from '../motion/ScrollChromeHeader';
import Budgets from '../../app/(tabs)/budgets';
import Transactions from '../../app/(tabs)/transactions';
import Accounts from '../../app/(tabs)/accounts';
import Insights from '../../app/(tabs)/insights';
import Goals from '../../app/(tabs)/goals';

beforeEach(() => { mockPush.mockClear(); });

describe('SettingsButton (the header gear)', () => {
  it('is an accessible "Settings" button and navigates to /settings on press', () => {
    render(<SettingsButton />);
    const btn = screen.getByLabelText('Settings');
    expect(btn.props.accessibilityRole).toBe('button');
    fireEvent.press(btn);
    expect(mockPush).toHaveBeenCalledWith('/settings');
  });

  it('pads the touch target past the 44x44 minimum (hitSlop, not a scaled glyph)', () => {
    render(<SettingsButton />);
    // 40x40 visual + hitSlop 8 on each side = 56x56 touchable, clears the 44x44 floor.
    expect(screen.getByLabelText('Settings').props.hitSlop).toBe(8);
  });
});

it('renders the gear BEFORE the title in the shared header (VoiceOver focus order)', () => {
  const tree = render(
    <ScrollChromeHeader title="TITLE_MARKER" left={<Text>GEAR_MARKER</Text>}>
      <Text>body</Text>
    </ScrollChromeHeader>,
  );
  const serialized = JSON.stringify(tree.toJSON());
  expect(serialized.indexOf('GEAR_MARKER')).toBeGreaterThanOrEqual(0);
  expect(serialized.indexOf('GEAR_MARKER')).toBeLessThan(serialized.indexOf('TITLE_MARKER'));
});

// The whole point of the ticket: the gear must be on EVERY remaining tab. A dropped `left` on any
// one screen makes that screen's case fail here.
describe.each([
  ['Budgets', <Budgets />],
  ['Transactions', <Transactions />],
  ['Accounts', <Accounts />],
  ['Insights', <Insights />],
  ['Goals', <Goals />],
] as [string, React.ReactElement][])('the Settings gear is present on %s', (_name, ui) => {
  it('renders a "Settings" header button that opens /settings', () => {
    render(ui);
    const btn = screen.getByLabelText('Settings');
    fireEvent.press(btn);
    expect(mockPush).toHaveBeenCalledWith('/settings');
  });
});
