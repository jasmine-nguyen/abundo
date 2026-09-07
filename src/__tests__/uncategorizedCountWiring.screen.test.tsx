// WHIT-501 — the Transactions screen + nav-bar tab dot now read the WHOLE-history server tally
// (useUncategorizedCount) instead of only the loaded/recent rows. These lock the wiring:
//   - the tab badge shows the SERVER number when it has resolved (even when it differs from the
//     rows on screen), and falls back to the LOCAL count only while the server value is undefined
//     (loading / errored) — never to 0, which would flash a false empty state;
//   - "All caught up" shows ONLY on a RESOLVED server 0, never while the server value is undefined;
//   - the nav-bar dot hides on a resolved server 0 even if the recent window still has an unfiled
//     charge, and falls back to the recent-window count while the server value is undefined.
// Fail-on-revert: rewire any of these back to the local count and the matching test fails.
import { it, expect, jest, describe } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react-native';
import { txn } from './factory';

const noCategory = (_id: string | null) => undefined; // every row resolves to Uncategorized

// Mutable per test: the screen/tab-bar reads these through the mocked hooks below.
let mockServerCount: number | undefined;
let mockTx: { transactions: unknown[]; category: (id: string | null) => unknown } & Record<string, unknown>;
let mockRecent: { transactions: unknown[]; category: (id: string | null) => unknown } & Record<string, unknown>;

jest.mock('../queries', () => ({
  useTransactionsScreenData: () => mockTx,
  useRecentTransactionsScreenData: () => mockRecent,
  useKeepTransactionsFeedWarm: () => {},
  useUncategorizedCount: () => mockServerCount,
}));

// Real selectors (countUncategorized / transactionGroups); only useAppContext is stubbed.
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ openPicker: () => {}, openMultiPicker: () => {}, retryLoad: () => {}, showToast: () => {} }) };
});

jest.mock('expo-router', () => {
  const ReactLib = require('react');
  return {
    useFocusEffect: (cb: () => void) => ReactLib.useEffect(() => cb(), [cb]),
    useRouter: () => ({ push: jest.fn() }),
    Tabs: Object.assign(() => null, { Screen: () => null }),
  };
});
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('../motion/NavBarsContext', () => ({ useNavBars: () => ({ visibility: { interpolate: () => 0 } }) }));

import Transactions from '../../app/(tabs)/transactions';
import { TabBar } from '../../app/(tabs)/_layout';

function txData(over: Record<string, unknown> = {}) {
  return {
    transactions: [], category: noCategory, balances: new Map(),
    isLoading: false, isError: false, isFetching: false,
    hasMore: false, loadMore: () => {}, isLoadingMore: false,
    refetch: () => {}, refetchStale: () => {},
    refetchList: () => Promise.resolve(), refreshLiveBalances: () => Promise.resolve(),
    ...over,
  };
}

const barProps: React.ComponentProps<typeof TabBar> = {
  state: { index: 0, routes: [{ key: 'transactions', name: 'transactions' }] },
  navigation: { emit: () => ({ defaultPrevented: false }), navigate: jest.fn() },
};

describe('Transactions screen badge', () => {
  // Two unfiled rows on screen, but the server says the whole history has 7 → the badge shows 7.
  // Fail-on-revert: point the badge back at the local count → it shows 2, not 7.
  it('shows the RESOLVED server number even when it differs from the rows on screen', () => {
    mockServerCount = 7;
    mockTx = txData({ transactions: [txn({ transaction_id: 't1', category: null }), txn({ transaction_id: 't2', category: null })] });
    render(<Transactions />);
    expect(within(screen.getByTestId('tab-uncategorized')).getByText('7')).toBeTruthy();
  });

  // Server value still loading (undefined) → the badge falls back to the local loaded-page count (2).
  it('falls back to the local count while the server value is undefined', () => {
    mockServerCount = undefined;
    mockTx = txData({ transactions: [txn({ transaction_id: 't1', category: null }), txn({ transaction_id: 't2', category: null })] });
    render(<Transactions />);
    expect(within(screen.getByTestId('tab-uncategorized')).getByText('2')).toBeTruthy();
  });
});

describe('Transactions screen "All caught up"', () => {
  // A resolved server 0 is the ONLY thing that shows the strong "everything is filed" empty state.
  it('shows "All caught up" on a resolved server 0', () => {
    mockServerCount = 0;
    mockTx = txData({ transactions: [] });
    render(<Transactions />);
    fireEvent.press(screen.getByTestId('tab-uncategorized'));
    expect(screen.getByText('All caught up')).toBeTruthy();
  });

  // While the server value is undefined (loading/errored) we must NOT claim "All caught up", even
  // with an empty loaded page — older history might still hold an unfiled charge.
  // Fail-on-revert: gate allCaughtUp on the local count (0) instead of a resolved server 0 → this fails.
  it('does NOT show "All caught up" while the server value is undefined', () => {
    mockServerCount = undefined;
    mockTx = txData({ transactions: [] });
    render(<Transactions />);
    fireEvent.press(screen.getByTestId('tab-uncategorized'));
    expect(screen.queryByText('All caught up')).toBeNull();
  });

  // A resolved server 0 that DISAGREES with the loaded rows (a cross-device / server-side re-tag
  // dropped the tally to 0 while the never-invalidated feed cache still holds unfiled rows) must NOT
  // render "All caught up" ABOVE a visible list of uncategorized rows. The empty state requires the
  // tab to actually be empty. Fail-on-revert: drop the `groups.length === 0` guard on the empty
  // state → "All caught up" renders alongside the WOOLWORTHS row and this fails.
  it('does NOT show "All caught up" when server says 0 but unfiled rows are still loaded', () => {
    mockServerCount = 0;
    mockTx = txData({ transactions: [txn({ transaction_id: 't1', category: null })] });
    render(<Transactions />);
    fireEvent.press(screen.getByTestId('tab-uncategorized'));
    expect(screen.queryByText('All caught up')).toBeNull(); // no false empty state over real rows
    expect(screen.getByText('Woolworths')).toBeTruthy();    // the unfiled row is still shown
    // The "tap a transaction" hint keys off the LOCAL loaded-page count (not the server tally), so it
    // stays visible while unfiled rows are on screen — the contrast the plan intends.
    expect(screen.getByText(/Tap a transaction to categorize it/)).toBeTruthy();
  });
});

describe('nav-bar tab dot', () => {
  // The recent window still shows an unfiled charge, but the server tally is a resolved 0 →
  // the whole history is filed → hide the dot. Fail-on-revert: drive the dot off the local recent
  // count → it shows the dot here.
  it('hides the dot on a resolved server 0 even when the recent window has an unfiled charge', () => {
    mockServerCount = 0;
    mockRecent = txData({ transactions: [txn({ category: null, counts_to_budget: true })] });
    render(<TabBar {...barProps} />);
    expect(screen.queryByTestId('tab-uncat-dot')).toBeNull();
  });

  // Server value undefined (loading) → fall back to the recent-window count, which has one → dot shows.
  it('falls back to the recent-window count while the server value is undefined', () => {
    mockServerCount = undefined;
    mockRecent = txData({ transactions: [txn({ category: null, counts_to_budget: true })] });
    render(<TabBar {...barProps} />);
    expect(screen.getByTestId('tab-uncat-dot')).toBeTruthy();
  });
});
