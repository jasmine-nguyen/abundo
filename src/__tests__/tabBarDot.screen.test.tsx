// The tab bar over the fake server: the real useRecentTransactionsScreenData,
// useKeepTransactionsFeedWarm and useUncategorizedCount run; only fetch is faked.
// Folded from tabBadgeQuery (WHIT-203), tabBarNoSettings (WHIT-495), tabDotNotDuplicated (WHIT-215)
// and whit330TabDot (WHIT-330).
//
// WHIT-501: the dot trusts the server's whole-history count once it resolves, and falls back to
// the LOCAL recent-window count only while that count is loading or failed. The fallback tests
// fail the count route so the local count over the seeded recent rows drives the dot.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, within, waitFor } from '@testing-library/react-native';
import { txn } from './factory';
import { installFakeServer } from './support/fakeServer';
import { tabBarProps, TAB_ROUTES } from './support/tabBar';
import { WithQueries, refreshInAct, renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { COFFEE_SHORT } from './support/categories';
import { queryClient } from '../queryClient';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('../motion/NavBarsContext', () => ({ useNavBars: () => ({ visibility: { interpolate: () => 0 } }) }));
// expo-router's Tabs pulls in native modules that can't load headlessly; the TabBar under
// test doesn't use them, so stub the module.
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import { TabBar } from '../../app/(tabs)/_layout';

const server = installFakeServer();
useTestQueryClient();

const COUNT = '/transactions/uncategorized/count';

const singleTab = tabBarProps(['transactions']);

// The full navigator route set, in order, incl. the Accounts tab at index 2.
const fiveTabs = tabBarProps(TAB_ROUTES, 1);

// getByText returns the inner text node; its host Pressable is two parents up (composite Text →
// host View). Scope testID queries to that per-tab subtree so a dot is attributed to the right tab.
const tabItem = (label: string) => within(screen.getByText(label).parent!.parent!);

beforeEach(() => resetAuth());

describe('the dot falls back to the local recent-window count when the server count fails', () => {
  beforeEach(() => {
    server.fail(COUNT, 500);
    server.seed('/categories', [COFFEE_SHORT]);
  });

  // WHIT-203: the dot comes from the tab bar's own recent-transactions read. Reverting the tab bar
  // off that read (or breaking countUncategorized's input) fails these.
  it.each([
    ['an uncategorized, budget-counting txn', null, true],
    ['none uncategorized', 'coffee', false],
  ])('the dot shows when the recent list has %s → %s', async (_case, category, shown) => {
    server.seed('/transactions', [txn({ category, counts_to_budget: true })]);
    await renderWithQueries(<TabBar {...singleTab} />);
    expect(screen.queryByTestId('tab-uncat-dot') !== null).toBe(shown);
  });

  // WHIT-330: a transfers-only account (every unfiled charge is a not-in-budget transfer) lights
  // the dot. Fail-on-revert: restore the `contributesToBudget(t) &&` gate in countUncategorized →
  // this account counts 0 → no dot.
  it('lights the tab dot when the only unfiled charge is a not-in-budget transfer (WHIT-330)', async () => {
    server.seed('/transactions', [txn({ transaction_id: 'xfer', category: null, counts_to_budget: false })]);
    await renderWithQueries(<TabBar {...singleTab} />);
    expect(screen.getByTestId('tab-uncat-dot')).toBeTruthy();
  });

  // WHIT-215: the dot lights exactly one tab (Transactions), never the Accounts tab beside it.
  // Fail-on-revert: widen the `meta.name === 'transactions'` dot gate to also match 'accounts'
  // (or drop the name check) → two dots.
  it('lights exactly one uncategorized dot, on Transactions — never duplicated onto the Accounts tab', async () => {
    server.seed('/transactions', [txn({ category: null, counts_to_budget: true })]);
    await renderWithQueries(<TabBar {...fiveTabs} />);
    expect(screen.getAllByTestId('tab-uncat-dot')).toHaveLength(1);
    expect(tabItem('Transactions').getByTestId('tab-uncat-dot')).toBeTruthy();
    expect(tabItem('Accounts').queryByTestId('tab-uncat-dot')).toBeNull();
  });

  // [A3] WHIT-203: the fallback reads the BOUNDED recent list (GET /transactions), not the paged
  // feed. Fail-on-revert: drive the dot from useTransactionsScreenData (the feed) → dot shows.
  it('[A3] the fallback ignores an unfiled charge that is only in the feed, not the recent list', async () => {
    server.seed('/transactions/feed', { transactions: [txn({ transaction_id: 'old', category: null, counts_to_budget: true })], nextCursor: null });
    server.seed('/transactions', [txn({ category: 'coffee', counts_to_budget: true })]);
    await renderWithQueries(<TabBar {...singleTab} />);
    expect(server.sent('GET', '/transactions')).toHaveLength(1);
    expect(screen.queryByTestId('tab-uncat-dot')).toBeNull();
  });

  // [A5] The local fallback resolves the category through the seeded taxonomy: a row filed to a
  // category the taxonomy no longer has counts as unfiled. Fail-on-revert: count only null
  // categories (ignore the taxonomy lookup) → no dot.
  it('[A5] the fallback counts a row filed to a category missing from the taxonomy', async () => {
    server.seed('/transactions', [txn({ category: 'deleted-cat', counts_to_budget: true })]);
    await renderWithQueries(<TabBar {...singleTab} />);
    expect(screen.getByTestId('tab-uncat-dot')).toBeTruthy();
  });
});

describe('the dot trusts the server count once it resolves', () => {
  beforeEach(() => { server.seed('/categories', [COFFEE_SHORT]); });

  // WHIT-501: older history can hold an unfiled charge the recent window doesn't show; the server's
  // whole-history count must light the dot anyway.
  it('lights the dot from the server count when the recent list has nothing unfiled', async () => {
    server.seed(COUNT, { count: 2 });
    await renderWithQueries(<TabBar {...singleTab} />);
    expect(screen.getByTestId('tab-uncat-dot')).toBeTruthy();
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
});
