// WHIT-215 GAP (accounts-separate-tab) — the tab bar renders FIVE tabs incl. the Accounts tab
// (WHIT-495 later moved Settings to a header gear). The uncategorized red dot must still light
// EXACTLY ONE tab (Transactions) and
// must NOT be duplicated onto the new Accounts tab. The existing tabBadgeQuery / whit330TabDot
// tests render the bar with a SINGLE transactions route, so they can't catch a dot that leaks
// onto a sibling tab. This renders the full route set and asserts one dot, on Transactions.
// Fail-on-revert: widen the `meta.name === 'transactions'` dot gate to also match 'accounts'
// (or drop the name check) → two dots → this goes RED.
import { it, expect, jest } from '@jest/globals';
import React from 'react';
import { render, screen, within } from '@testing-library/react-native';
import { txn } from './factory';

const uncategorized = (_id: string | null) => undefined; // rows resolve to no category → uncategorized
let mockTx: { transactions: unknown[]; category: (id: string | null) => unknown };
jest.mock('../queries', () => ({ useRecentTransactionsScreenData: () => mockTx, useKeepTransactionsFeedWarm: () => {} }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('../motion/NavBarsContext', () => ({ useNavBars: () => ({ visibility: { interpolate: () => 0 } }) }));
jest.mock('expo-router', () => ({ Tabs: Object.assign(() => null, { Screen: () => null }) }));

import { TabBar } from '../../app/(tabs)/_layout';

// The full navigator route set, in order, incl. the Accounts tab at index 2.
const barProps: React.ComponentProps<typeof TabBar> = {
  state: {
    index: 1,
    routes: [
      { key: 'budgets', name: 'budgets' },
      { key: 'transactions', name: 'transactions' },
      { key: 'accounts', name: 'accounts' },
      { key: 'insights', name: 'insights' },
      { key: 'goals', name: 'goals' },
    ],
  },
  navigation: { emit: () => ({ defaultPrevented: false }), navigate: jest.fn() },
};

// getByText returns the inner text node; its host Pressable is two parents up (composite Text →
// host View). Scope testID queries to that per-tab subtree so a dot is attributed to the right tab.
const tabItem = (label: string) => within(screen.getByText(label).parent!.parent!);

it('lights exactly one uncategorized dot, on Transactions — never duplicated onto the new Accounts tab', () => {
  mockTx = { transactions: [txn({ category: null, counts_to_budget: true })], category: uncategorized };
  render(<TabBar {...barProps} />);
  // Exactly one dot across all six tabs.
  expect(screen.getAllByTestId('tab-uncat-dot')).toHaveLength(1);
  // And it's on Transactions, not Accounts.
  expect(tabItem('Transactions').getByTestId('tab-uncat-dot')).toBeTruthy();
  expect(tabItem('Accounts').queryByTestId('tab-uncat-dot')).toBeNull();
});

it('no dot on any tab when nothing is uncategorized (Accounts tab stays clean too)', () => {
  mockTx = { transactions: [txn({ category: 'coffee', counts_to_budget: true })], category: (id: string | null) => (id ? { id } : undefined) };
  render(<TabBar {...barProps} />);
  expect(screen.queryByTestId('tab-uncat-dot')).toBeNull();
});
