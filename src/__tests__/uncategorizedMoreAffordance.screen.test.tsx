// The paged Uncategorized tab's `showUncategorizedMore` affordance (transactions.tsx). The core
// positive states (More to load / Nothing to show yet) and the not-on-All / All-caught-up cases are
// locked over the REAL query layer in uncategorizedMoreState.screen.test.tsx. This suite covers the
// SUPPRESSION edges that need a serverCount driven INDEPENDENTLY of the loaded rows and a
// deterministic cold-load/error/undefined-count state — cheaper to force via direct mocks here:
// the affordance must never co-render with the "No matches" search state, the cold spinner, the
// error state, or flash before the count resolves.
import { it, expect, jest, beforeEach, describe } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react-native';
import { RefreshControl } from 'react-native';

let mockTx: Record<string, unknown>;
let mockServerCount: number | undefined;
jest.mock('../queries', () => ({
  useTransactionsScreenData: () => mockTx,
  useUncategorizedCount: () => mockServerCount,
}));

const CAT = { id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#7FD49B', recent: 0 };
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return {
    ...actual,
    useAppContext: () => ({ openMultiPicker: jest.fn(), showToast: jest.fn(), openPicker: jest.fn() }),
  };
});
jest.mock('expo-router', () => {
  const ReactLib = require('react');
  return { useFocusEffect: (cb: () => void) => ReactLib.useEffect(() => cb(), [cb]), useRouter: () => ({ push: jest.fn() }) };
});

import Transactions from '../../app/(tabs)/transactions';

const category = (id: string | null) => (id === 'groceries' ? CAT : undefined);
function txData(over: Record<string, unknown> = {}) {
  return {
    transactions: [], category, balances: new Map(),
    isLoading: false, isError: false, isFetching: false, refetch: jest.fn(), refetchStale: jest.fn(),
    refetchList: jest.fn(() => Promise.resolve()), refreshLiveBalances: jest.fn(() => Promise.resolve()),
    hasMore: false, loadMore: jest.fn(), isLoadingMore: false, ...over,
  };
}

beforeEach(() => { mockTx = txData(); mockServerCount = undefined; });

const MORE = 'transactions-uncategorized-more';

describe('Uncategorized tab — "more to load" affordance suppression edges', () => {
  // A search query suppresses it — the "No matches" state owns a search miss, not this affordance.
  it('does not render while a search query is active (No matches owns that)', () => {
    mockServerCount = 639;
    mockTx = txData({ transactions: [], hasMore: true });
    render(<Transactions />);
    fireEvent.press(screen.getByTestId('tab-uncategorized'));
    fireEvent.changeText(screen.getByPlaceholderText('Search transactions'), 'zzzz');
    expect(screen.queryByTestId(MORE)).toBeNull();
  });

  // Cold load (empty + isLoading) shows the spinner, not this affordance.
  it('does not render during a cold load (the spinner owns it)', () => {
    mockServerCount = 639;
    mockTx = txData({ transactions: [], hasMore: true, isLoading: true });
    render(<Transactions />);
    fireEvent.press(screen.getByTestId('tab-uncategorized'));
    expect(screen.getByTestId('transactions-loading')).toBeTruthy();
    expect(screen.queryByTestId(MORE)).toBeNull();
  });

  // An errored empty list shows the inline error, not this affordance.
  it('does not render on an errored empty list (the error state owns it)', () => {
    mockServerCount = 639;
    mockTx = txData({ transactions: [], hasMore: true, isError: true });
    render(<Transactions />);
    fireEvent.press(screen.getByTestId('tab-uncategorized'));
    expect(screen.getByTestId('transactions-error')).toBeTruthy();
    expect(screen.queryByTestId(MORE)).toBeNull();
  });

  // Count still loading (undefined) with no more pages → neither hasMore nor serverCount>0, so it stays
  // hidden (no flash before the count resolves).
  it('does not render while the count is still loading and there are no more pages', () => {
    mockServerCount = undefined; // count query not yet resolved
    mockTx = txData({ transactions: [], hasMore: false });
    render(<Transactions />);
    fireEvent.press(screen.getByTestId('tab-uncategorized'));
    expect(screen.queryByTestId(MORE)).toBeNull();
  });

  // The "Nothing to show yet" copy invites a pull; the pull spinner must actually show there, even
  // though the list is empty (the length>0 gate is widened by showUncategorizedMore). Fail-on-revert:
  // drop the `|| showUncategorizedMore` from the refreshing gate → the spinner stays down → RED.
  it('shows the pull spinner on the "Nothing to show yet" state (the instruction is honest)', () => {
    mockServerCount = 3;
    let resolveList: () => void = () => {};
    mockTx = txData({
      transactions: [], hasMore: false,
      refetchList: jest.fn(() => new Promise<void>((r) => { resolveList = r; })), // stay pending mid-pull
    });
    const { UNSAFE_getByType } = render(<Transactions />);
    fireEvent.press(screen.getByTestId('tab-uncategorized'));
    expect(screen.getByText('Nothing to show yet')).toBeTruthy();

    act(() => { UNSAFE_getByType(RefreshControl).props.onRefresh(); });
    expect(UNSAFE_getByType(RefreshControl).props.refreshing).toBe(true); // spinner shows despite the empty list

    act(() => { resolveList(); }); // settle so the .finally clears pulling (no dangling act)
  });
});
