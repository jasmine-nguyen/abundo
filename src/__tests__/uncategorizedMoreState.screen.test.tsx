// WHIT-501 gap — the Uncategorized tab's "two-scan skew" empty states (transactions.tsx
// showUncategorizedMore) exercised over the REAL query layer end-to-end (real composite + real
// count query), which the mock-based uncategorizedMoreAffordance suite can't. The badge is a
// whole-history server count; the list is a paged feed. When the badge says there ARE unfiled
// charges but the loaded pages show none, the tab must EXPLAIN itself rather than go blank:
//   * more history to page  -> "More to load"
//   * no more pages, stale/skewed badge -> "Nothing to show yet"
// and it must NEVER appear on the 'all' tab, nor compete with "All caught up".
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

jest.mock('../auth', () => ({ getStatus: () => 'authed', subscribe: () => () => {} }));

const mockFeed = jest.fn<(c?: string) => Promise<unknown>>();
const mockUncat = jest.fn<(c?: string) => Promise<unknown>>();
const mockCount = jest.fn<() => Promise<number>>();
const mockCategories = jest.fn<() => Promise<unknown>>();
const mockTransactions = jest.fn<() => Promise<unknown>>();
const mockBalances = jest.fn<() => Promise<unknown>>();
const mockRefreshBalances = jest.fn<() => Promise<unknown>>();
jest.mock('../api', () => ({
  fetchTransactionsFeed: (c?: string) => mockFeed(c),
  fetchUncategorizedFeed: (c?: string) => mockUncat(c),
  fetchUncategorizedCount: () => mockCount(),
  fetchCategories: () => mockCategories(),
  fetchTransactions: () => mockTransactions(),
  fetchAccountBalances: () => mockBalances(),
  refreshAccountBalances: () => mockRefreshBalances(),
}));

// ../context PARTIAL — real selectors (transactionGroups/countUncategorized) so the tab list is
// real; stub useAppContext for the row/multi-picker/toast the screen consumes.
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ openMultiPicker: jest.fn(), showToast: jest.fn() }) };
});
jest.mock('expo-router', () => {
  const ReactLib = require('react');
  return { useFocusEffect: (cb: () => void) => ReactLib.useEffect(() => cb(), [cb]), useRouter: () => ({ push: jest.fn() }) };
});

import Transactions from '../../app/(tabs)/transactions';

function renderScreen() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000, gcTime: Infinity } } });
  return render(React.createElement(QueryClientProvider, { client }, React.createElement(Transactions)));
}

beforeEach(() => {
  mockFeed.mockReset().mockResolvedValue({ transactions: [], nextCursor: null });
  mockUncat.mockReset();
  mockCount.mockReset();
  mockCategories.mockReset().mockResolvedValue([]);
  mockTransactions.mockReset().mockResolvedValue([]);
  mockBalances.mockReset().mockResolvedValue([]);
  mockRefreshBalances.mockReset().mockResolvedValue([]);
});

// [C4a] badge>0, empty first page but a live cursor -> "More to load" (deep rows a Load More away).
it('shows "More to load" when the loaded page is empty but the cursor says more history', async () => {
  mockCount.mockResolvedValue(639);
  mockUncat.mockResolvedValue({ transactions: [], nextCursor: 'deep-cursor' });
  renderScreen();
  fireEvent.press(screen.getByTestId('tab-uncategorized'));

  expect(await screen.findByText('More to load')).toBeTruthy();
  expect(screen.queryByText('All caught up')).toBeNull();            // NOT the caught-up claim
});

// [C4b] badge>0, empty page AND no more pages (stale/skewed badge) -> "Nothing to show yet".
it('shows "Nothing to show yet" when the badge is ahead but there are no more pages', async () => {
  mockCount.mockResolvedValue(3);
  mockUncat.mockResolvedValue({ transactions: [], nextCursor: null }); // history exhausted, list empty
  renderScreen();
  fireEvent.press(screen.getByTestId('tab-uncategorized'));

  expect(await screen.findByText('Nothing to show yet')).toBeTruthy();
  expect(screen.queryByText('More to load')).toBeNull();
});

// [C4c] the more-state must NEVER appear on the 'all' tab, even with a non-zero badge + empty feed.
it('never shows the more-state on the All tab', async () => {
  mockCount.mockResolvedValue(639);
  mockUncat.mockResolvedValue({ transactions: [], nextCursor: 'deep-cursor' });
  renderScreen(); // stays on 'all'
  // Force the server count to RESOLVE (the badge renders it), so the only thing that could keep
  // the more-state hidden is the `tab === 'uncategorized'` guard — not an unresolved serverCount.
  expect(await screen.findByText('639')).toBeTruthy();
  await waitFor(() => expect(mockFeed).toHaveBeenCalled());

  expect(screen.queryByTestId('transactions-uncategorized-more')).toBeNull();
  expect(screen.queryByText('More to load')).toBeNull();
});

// [C4d] a resolved server 0 -> "All caught up", and the more-state must NOT compete with it.
it('shows "All caught up" (not the more-state) on a resolved server zero', async () => {
  mockCount.mockResolvedValue(0);
  mockUncat.mockResolvedValue({ transactions: [], nextCursor: null });
  renderScreen();
  fireEvent.press(screen.getByTestId('tab-uncategorized'));

  expect(await screen.findByText('All caught up')).toBeTruthy();
  expect(screen.queryByTestId('transactions-uncategorized-more')).toBeNull();
});
