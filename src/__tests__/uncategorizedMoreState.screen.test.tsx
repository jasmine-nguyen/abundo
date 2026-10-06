// WHIT-501 gap — the Uncategorized tab's "two-scan skew" empty states (transactions.tsx
// showUncategorizedMore) exercised over the REAL query layer end-to-end (real composite + real
// count query), which the mock-based uncategorizedMoreAffordance suite can't. The badge is a
// whole-history server count; the list is a paged feed. When the badge says there ARE unfiled
// charges but the loaded pages show none, the tab must EXPLAIN itself rather than go blank:
//   * more history to page  -> "More to load"
//   * no more pages, stale/skewed badge -> "Nothing to show yet"
// and it must NEVER appear on the 'all' tab, nor compete with "All caught up".
// Real ../api over the fake server; ../auth + expo-router mocked.
import { it, expect, jest } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeClient } from './support/queryClient';
import { installFakeServer } from './support/fakeServer';

jest.mock('../auth', () => require('./support/authMock').authMockModule());

// ../context PARTIAL — real selectors (transactionGroups/countUncategorized) so the tab list is
// real; stub useAppContext for the row/multi-picker/toast the screen consumes.
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ openMultiPicker: jest.fn(), showToast: jest.fn() }) };
});
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import Transactions from '../../app/(tabs)/transactions';

const server = installFakeServer();
const UNCATEGORIZED_FEED = '/transactions/uncategorized/feed';
const COUNT = '/transactions/uncategorized/count';

function renderScreen() {
  return render(React.createElement(QueryClientProvider, { client: makeClient() }, React.createElement(Transactions)));
}

// [C4a] badge>0, empty first page but a live cursor -> "More to load" (deep rows a Load More away).
it('shows "More to load" when the loaded page is empty but the cursor says more history', async () => {
  server.seed(COUNT, { count: 639 });
  server.seed(UNCATEGORIZED_FEED,{ transactions: [], nextCursor: 'deep-cursor' });
  renderScreen();
  fireEvent.press(screen.getByTestId('tab-uncategorized'));

  expect(await screen.findByText('More to load')).toBeTruthy();
  expect(screen.queryByText('All caught up')).toBeNull();            // NOT the caught-up claim
});

// [C4b] badge>0, empty page AND no more pages (stale/skewed badge) -> "Nothing to show yet".
it('shows "Nothing to show yet" when the badge is ahead but there are no more pages', async () => {
  server.seed(COUNT, { count: 3 });
  server.seed(UNCATEGORIZED_FEED,{ transactions: [], nextCursor: null }); // history exhausted, list empty
  renderScreen();
  fireEvent.press(screen.getByTestId('tab-uncategorized'));

  expect(await screen.findByText('Nothing to show yet')).toBeTruthy();
  expect(screen.queryByText('More to load')).toBeNull();
});

// [C4c] the more-state must NEVER appear on the 'all' tab, even with a non-zero badge + empty feed.
it('never shows the more-state on the All tab', async () => {
  server.seed(COUNT, { count: 639 });
  server.seed(UNCATEGORIZED_FEED,{ transactions: [], nextCursor: 'deep-cursor' });
  renderScreen(); // stays on 'all'
  // Force the server count to RESOLVE (the badge renders it), so the only thing that could keep
  // the more-state hidden is the `tab === 'uncategorized'` guard — not an unresolved serverCount.
  expect(await screen.findByText('639')).toBeTruthy();
  await waitFor(() => expect(server.sentUnder('GET', '/transactions/feed').length).toBeGreaterThan(0));

  expect(screen.queryByTestId('transactions-uncategorized-more')).toBeNull();
  expect(screen.queryByText('More to load')).toBeNull();
});

// [C4d] a resolved server 0 -> "All caught up", and the more-state must NOT compete with it.
it('shows "All caught up" (not the more-state) on a resolved server zero', async () => {
  server.seed(COUNT, { count: 0 });
  server.seed(UNCATEGORIZED_FEED,{ transactions: [], nextCursor: null });
  renderScreen();
  fireEvent.press(screen.getByTestId('tab-uncategorized'));

  expect(await screen.findByText('All caught up')).toBeTruthy();
  expect(screen.queryByTestId('transactions-uncategorized-more')).toBeNull();
});
