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
import { screen, within } from '@testing-library/react-native';
import { txn } from './factory';
import { installFakeServer } from './support/fakeServer';
import { tabBarProps, TAB_ROUTES } from './support/tabBar';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { COFFEE_SHORT } from './support/categories';
import { styleOf } from './support/layout';
import { ChatProvider } from '../chat/ChatContext';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
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
  it('renders the dot when the recent list has an uncategorized, budget-counting txn', async () => {
    server.seed('/transactions', [txn({ category: null, counts_to_budget: true })]);
    await renderWithQueries(<TabBar {...singleTab} />);
    expect(screen.getByTestId('tab-uncat-dot')).toBeTruthy();
  });

  it('renders no dot when the recent list has none uncategorized', async () => {
    server.seed('/transactions', [txn({ category: 'coffee', counts_to_budget: true })]);
    await renderWithQueries(<TabBar {...singleTab} />);
    expect(screen.queryByTestId('tab-uncat-dot')).toBeNull();
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

  it('no dot on any tab when nothing is uncategorized (Accounts tab stays clean too)', async () => {
    server.seed('/transactions', [txn({ category: 'coffee', counts_to_budget: true })]);
    await renderWithQueries(<TabBar {...fiveTabs} />);
    expect(screen.queryByTestId('tab-uncat-dot')).toBeNull();
  });
});

// WHIT-501: older history can hold an unfiled charge the recent window doesn't show; the server's
// whole-history count must light the dot anyway.
it('lights the dot from the server count when the recent list has nothing unfiled', async () => {
  server.seed(COUNT, { count: 2 });
  await renderWithQueries(<TabBar {...singleTab} />);
  expect(screen.getByTestId('tab-uncat-dot')).toBeTruthy();
});

// WHIT-495: the Settings tab became a header gear, so the bar renders exactly the five remaining
// tabs and never a "Settings" item, even when the navigator still passes a settings route.
// Fail-on-revert: re-add `{ name: 'settings', label: 'Settings', icon: 'navSettings' }` to TABS
// → the settings route renders a "Settings" tab.
it('renders the five remaining tabs and never a Settings tab, even when a settings route is present', async () => {
  const withSettings = tabBarProps([...TAB_ROUTES, 'settings']);
  await renderWithQueries(<TabBar {...withSettings} />);
  for (const label of ['Budgets', 'Transactions', 'Accounts', 'Insights', 'Goals']) {
    expect(screen.getByText(label)).toBeTruthy();
  }
  expect(screen.queryByText('Settings')).toBeNull();
});

describe('WHIT-735 tab labels', () => {
  // [A6] (P0) every tab label is at least Apple's 11pt, and still shrinks to fit on one line.
  it('[A6] all five tab labels are 11pt or more and keep their one-line shrink-to-fit', async () => {
    await renderWithQueries(<ChatProvider><TabBar {...tabBarProps()} /></ChatProvider>);

    for (const label of ['Budgets', 'Transactions', 'Accounts', 'Insights', 'Goals']) {
      const text = screen.getByText(label);
      expect(styleOf(text).fontSize).toBeGreaterThanOrEqual(11);
      expect(text.props).toMatchObject({ numberOfLines: 1, adjustsFontSizeToFit: true, maxFontSizeMultiplier: 1.2 });
    }
  });
});
