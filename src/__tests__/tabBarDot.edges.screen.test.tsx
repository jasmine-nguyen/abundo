// WHIT-688 QA — the tab-bar dot's edges over the fake server: the real useUncategorizedCount,
// useRecentTransactionsScreenData and useKeepTransactionsFeedWarm run; only fetch is faked.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';
import { txn } from './factory';
import { installFakeServer } from './support/fakeServer';
import { WithQueries, refreshInAct, renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { queryClient } from '../queryClient';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('../motion/NavBarsContext', () => ({ useNavBars: () => ({ visibility: { interpolate: () => 0 } }) }));
jest.mock('expo-router', () => ({ Tabs: Object.assign(() => null, { Screen: () => null }) }));

import { TabBar } from '../../app/(tabs)/_layout';

const server = installFakeServer();
useTestQueryClient();

const COUNT = '/transactions/uncategorized/count';
const COFFEE = { id: 'coffee', name: 'Coffee', icon: 'coffee', bucket: 'Lifestyle' };

const singleTab: React.ComponentProps<typeof TabBar> = {
  state: { index: 0, routes: [{ key: 'transactions', name: 'transactions' }] },
  navigation: { emit: () => ({ defaultPrevented: false }), navigate: jest.fn() },
};

beforeEach(() => {
  resetAuth();
  server.seed('/categories', [COFFEE]);
});

// [A1] WHIT-501: a RESOLVED server 0 is trusted over the recent window. Fail-on-revert: make the
// dot fall back on a falsy count (`serverCount || local`) or take the max → dot shows.
it('[A1] hides the dot on a resolved server count of 0 even when the recent list has an unfiled charge', async () => {
  server.seed(COUNT, { count: 0 });
  server.seed('/transactions', [txn({ category: null, counts_to_budget: true })]);
  await renderWithQueries(<TabBar {...singleTab} />);
  expect(server.sent('GET', COUNT)).toHaveLength(1);
  expect(screen.queryByTestId('tab-uncat-dot')).toBeNull();
});

// [A2] WHIT-501: while the server count is still loading, the dot falls back to the local count
// (never to 0). Fail-on-revert: `serverCount ?? 0` → no dot while loading.
it('[A2] lights the dot from the recent list while the server count is still loading', async () => {
  const held = server.hold(COUNT);
  server.seed('/transactions', [txn({ category: null, counts_to_budget: true })]);
  render(<WithQueries><TabBar {...singleTab} /></WithQueries>);
  // Every read but the held count settles; read the dot, then release before asserting so a
  // failure never leaves the held request open.
  await waitFor(() => expect(queryClient.isFetching()).toBe(1));
  const dotWhileLoading = screen.queryByTestId('tab-uncat-dot');
  // The server answers 0 (default) → the resolved value now wins and the dot goes away.
  // The held reply resolves over a few promise hops, so wait for the read to land inside act.
  await refreshInAct(async () => {
    held.release();
    while (queryClient.isFetching() > 0) await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(dotWhileLoading).not.toBeNull();
  expect(server.sent('GET', COUNT)).toHaveLength(1);
  expect(screen.queryByTestId('tab-uncat-dot')).toBeNull();
});

// [A3] WHIT-203: the fallback reads the BOUNDED recent list (GET /transactions), not the paged
// feed. Fail-on-revert: drive the dot from useTransactionsScreenData (the feed) → dot shows.
it('[A3] the fallback ignores an unfiled charge that is only in the feed, not the recent list', async () => {
  server.fail(COUNT, 500);
  server.seed('/transactions/feed', { transactions: [txn({ transaction_id: 'old', category: null, counts_to_budget: true })], nextCursor: null });
  server.seed('/transactions', [txn({ category: 'coffee', counts_to_budget: true })]);
  await renderWithQueries(<TabBar {...singleTab} />);
  expect(server.sent('GET', '/transactions')).toHaveLength(1);
  expect(screen.queryByTestId('tab-uncat-dot')).toBeNull();
});

// [A4] The tab bar keeps the feed's first page warm app-wide. Fail-on-revert: drop the
// useKeepTransactionsFeedWarm() call → no GET /transactions/feed.
it('[A4] reads the recent list, the categories, the count and warms the feed on first draw', async () => {
  await renderWithQueries(<TabBar {...singleTab} />);
  expect(server.sent('GET', '/transactions/feed')).toHaveLength(1);
  expect(server.sent('GET', '/transactions')).toHaveLength(1);
  expect(server.sent('GET', '/categories')).toHaveLength(1);
  expect(server.sent('GET', COUNT)).toHaveLength(1);
});

// [A5] The local fallback resolves the category through the seeded taxonomy: a row filed to a
// category the taxonomy no longer has counts as unfiled. Fail-on-revert: count only null
// categories (ignore the taxonomy lookup) → no dot.
it('[A5] the fallback counts a row filed to a category missing from the taxonomy', async () => {
  server.fail(COUNT, 500);
  server.seed('/transactions', [txn({ category: 'deleted-cat', counts_to_budget: true })]);
  await renderWithQueries(<TabBar {...singleTab} />);
  expect(screen.getByTestId('tab-uncat-dot')).toBeTruthy();
});

