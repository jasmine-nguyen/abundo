// WHIT-501 — the Transactions screen + nav-bar tab dot now read the WHOLE-history server tally
// (useUncategorizedCount) instead of only the loaded/recent rows. These lock the wiring:
//   - the tab badge shows the SERVER number when it has resolved (even when it differs from the
//     rows on screen), and falls back to the LOCAL count only while the server value is undefined
//     (loading / errored) — never to 0, which would flash a false empty state;
//   - "All caught up" shows ONLY on a RESOLVED server 0, never while the server value is undefined;
//   - the nav-bar dot hides on a resolved server 0 even if the recent window still has an unfiled
//     charge, and falls back to the recent-window count while the server value is undefined.
// Fail-on-revert: rewire any of these back to the local count and the matching test fails.
// The screens and their data code are real, over the pretend server (WHIT-686): "server value
// undefined" is the count request held open.
import { it, expect, jest, beforeEach, describe } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react-native';
import { txn } from './factory';

// Real selectors (countUncategorized / transactionGroups); only useAppContext is stubbed.
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ openPicker: () => {}, openMultiPicker: () => {}, retryLoad: () => {}, showToast: () => {} }) };
});
jest.mock('../auth', () => require('./support/authMock').authMockModule());

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
import { resetAuth } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient, renderWithQueries, WithQueries } from './support/renderWithQueries';
import { queryClient } from '../queryClient';
import { transactionsKey, uncategorizedFeedKey } from '../queries';

const server = installFakeServer();
useTestQueryClient();

const FEED = '/transactions/feed';
const UNCATEGORIZED_FEED = '/transactions/uncategorized/feed';
const RECENT = '/transactions';
const COUNT = '/transactions/uncategorized/count';

// No categories are seeded, so every row resolves to Uncategorized.
const seedFeed = (path: string, transactions: unknown[]) => server.seed(path, { transactions, nextCursor: null });
const settle = () => waitFor(() => expect(queryClient.isFetching()).toBe(0));
const loaded = (queryKey: readonly unknown[]) =>
  waitFor(() => expect(queryClient.getQueryState(queryKey)?.status).toBe('success'));

const barProps: React.ComponentProps<typeof TabBar> = {
  state: { index: 0, routes: [{ key: 'transactions', name: 'transactions' }] },
  navigation: { emit: () => ({ defaultPrevented: false }), navigate: jest.fn() },
};

beforeEach(() => {
  resetAuth();
});

describe('Transactions screen badge', () => {
  // Two unfiled rows on screen, but the server says the whole history has 7 → the badge shows 7.
  // Fail-on-revert: point the badge back at the local count → it shows 2, not 7.
  it('shows the RESOLVED server number even when it differs from the rows on screen', async () => {
    server.seed(COUNT, { count: 7 });
    seedFeed(FEED, [txn({ transaction_id: 't1', category: null }), txn({ transaction_id: 't2', category: null })]);
    await renderWithQueries(<Transactions />);
    expect(within(screen.getByTestId('tab-uncategorized')).getByText('7')).toBeTruthy();
  });

  // Server value still loading (undefined) → the badge falls back to the local loaded-page count (2).
  it('falls back to the local count while the server value is undefined', async () => {
    const held = server.hold(COUNT);
    seedFeed(FEED, [txn({ transaction_id: 't1', category: null }), txn({ transaction_id: 't2', category: null })]);
    render(<WithQueries><Transactions /></WithQueries>);
    await loaded(transactionsKey);
    expect(within(screen.getByTestId('tab-uncategorized')).getByText('2')).toBeTruthy();
    held.release();
    await settle();
  });
});

describe('Transactions screen "All caught up"', () => {
  // A resolved server 0 is the ONLY thing that shows the strong "everything is filed" empty state.
  it('shows "All caught up" on a resolved server 0', async () => {
    server.seed(COUNT, { count: 0 });
    await renderWithQueries(<Transactions />);
    fireEvent.press(screen.getByTestId('tab-uncategorized'));
    expect(await screen.findByText('All caught up')).toBeTruthy();
    await settle();
  });

  // While the server value is undefined (loading/errored) we must NOT claim "All caught up", even
  // with an empty loaded page — older history might still hold an unfiled charge.
  // Fail-on-revert: gate allCaughtUp on the local count (0) instead of a resolved server 0 → this fails.
  it('does NOT show "All caught up" while the server value is undefined', async () => {
    const held = server.hold(COUNT);
    render(<WithQueries><Transactions /></WithQueries>);
    fireEvent.press(screen.getByTestId('tab-uncategorized'));
    await loaded(uncategorizedFeedKey);
    expect(screen.queryByText('All caught up')).toBeNull();
    held.release();
    await settle();
  });

  // A resolved server 0 that DISAGREES with the loaded rows (a cross-device / server-side re-tag
  // dropped the tally to 0 while the never-invalidated feed cache still holds unfiled rows) must NOT
  // render "All caught up" ABOVE a visible list of uncategorized rows. The empty state requires the
  // tab to actually be empty. Fail-on-revert: drop the `groups.length === 0` guard on the empty
  // state → "All caught up" renders alongside the WOOLWORTHS row and this fails.
  it('does NOT show "All caught up" when server says 0 but unfiled rows are still loaded', async () => {
    server.seed(COUNT, { count: 0 });
    seedFeed(UNCATEGORIZED_FEED, [txn({ transaction_id: 't1', category: null })]);
    await renderWithQueries(<Transactions />);
    fireEvent.press(screen.getByTestId('tab-uncategorized'));
    expect(await screen.findByText('Woolworths')).toBeTruthy(); // the unfiled row is still shown
    expect(screen.queryByText('All caught up')).toBeNull();     // no false empty state over real rows
    // The "tap a transaction" hint keys off the LOCAL loaded-page count (not the server tally), so it
    // stays visible while unfiled rows are on screen — the contrast the plan intends.
    expect(screen.getByText(/Tap a transaction to categorize it/)).toBeTruthy();
    await settle();
  });
});

describe('nav-bar tab dot', () => {
  // The recent window still shows an unfiled charge, but the server tally is a resolved 0 →
  // the whole history is filed → hide the dot. Fail-on-revert: drive the dot off the local recent
  // count → it shows the dot here.
  it('hides the dot on a resolved server 0 even when the recent window has an unfiled charge', async () => {
    server.seed(COUNT, { count: 0 });
    server.seed(RECENT, [txn({ category: null, counts_to_budget: true })]);
    await renderWithQueries(<TabBar {...barProps} />);
    expect(screen.queryByTestId('tab-uncat-dot')).toBeNull();
  });

  // Server value undefined (loading) → fall back to the recent-window count, which has one → dot shows.
  it('falls back to the recent-window count while the server value is undefined', async () => {
    const held = server.hold(COUNT);
    server.seed(RECENT, [txn({ category: null, counts_to_budget: true })]);
    render(<WithQueries><TabBar {...barProps} /></WithQueries>);
    expect(await screen.findByTestId('tab-uncat-dot')).toBeTruthy();
    held.release();
    await settle();
  });

  // The tab bar keeps the Transactions feed warm, so the tab opens on loaded rows.
  it('reads the full feed in the background while the tab bar is up', async () => {
    seedFeed(FEED, [txn({ transaction_id: 't1' })]);
    await renderWithQueries(<TabBar {...barProps} />);
    expect(server.sentUnder('GET', '/transactions/feed')).toHaveLength(1);
    expect(queryClient.getQueryState(transactionsKey)?.status).toBe('success');
  });
});
