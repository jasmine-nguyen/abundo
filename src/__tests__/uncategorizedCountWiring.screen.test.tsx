// WHIT-501 — the Transactions screen reads the WHOLE-history server tally (useUncategorizedCount)
// instead of only the loaded rows. These lock the wiring:
//   - the tab badge shows the SERVER number when it has resolved (even when it differs from the
//     rows on screen), and falls back to the LOCAL count only while the server value is undefined
//     (loading / errored) — never to 0, which would flash a false empty state;
//   - "All caught up" shows ONLY on a RESOLVED server 0, never while the server value is undefined.
// The nav-bar dot's version of these lives in tabBarDot.screen.test.tsx.
// Fail-on-revert: rewire any of these back to the local count and the matching test fails.
// The screens and their data code are real, over the pretend server (WHIT-686): "server value
// undefined" is the count request held open.
import { it, expect, jest, beforeEach, describe } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react-native';
import { txn } from './factory';

// Real selectors (countUncategorized / transactionGroups); only useAppContext is stubbed.
jest.mock('../context', () =>
  require('./support/contextMock').realContextWith(() => ({ openPicker: () => {}, openMultiPicker: () => {}, retryLoad: () => {}, showToast: () => {} })),
);
jest.mock('../auth', () => require('./support/authMock').authMockModule());

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());
jest.mock('../motion/NavBarsContext', () => ({ useNavBars: () => ({ visibility: { interpolate: () => 0 } }) }));

import Transactions from '../../app/(tabs)/transactions';
import { resetAuth } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient, renderWithQueries, WithQueries, settle, loaded, refreshInAct } from './support/renderWithQueries';
import { GROCERIES_TOP } from './support/categories';
import { queryClient } from '../queryClient';
import { transactionsKey, uncategorizedFeedKey, uncategorizedCountKey } from '../queryKeys';

const server = installFakeServer();
useTestQueryClient();

const FEED = '/transactions/feed';
const UNCATEGORIZED_FEED = '/transactions/uncategorized/feed';
const COUNT = '/transactions/uncategorized/count';

// No categories are seeded, so every row resolves to Uncategorized.
const seedFeed = (path: string, transactions: unknown[], nextCursor: string | null = null) =>
  server.seed(path, { transactions, nextCursor });

async function renderUncategorizedTab() {
  await renderWithQueries(<Transactions />);
  fireEvent.press(screen.getByTestId('tab-uncategorized'));
  await settle();
}

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

// WHIT-552 / WHIT-686 — the filing buttons ("Apply my rules", "File by shop") and the shops request
// read the same `serverCount ?? local` count the badge does, and follow it live.
describe('filing buttons and the shops gate', () => {
  const MERCHANTS = '/transactions/uncategorized/merchants';
  const FILE_BY_SHOP = 'transactions-file-by-shop';
  const APPLY_RULES = 'transactions-apply-rules';
  const merchants = {
    unfiled: 20,
    groups: [{ merchant: 'Coles', rulePattern: 'coles', groupedBy: 'merchant', count: 20, samples: ['COLES 1'], firstDate: null, lastDate: null, alsoCatches: [] }],
    ungrouped: { count: 0, samples: [] },
  };
  const countFailed = () => waitFor(() => expect(queryClient.getQueryState(uncategorizedCountKey)?.status).toBe('error'));

  async function setCount(count: number) {
    server.seed(COUNT, { count });
    await refreshInAct(() => queryClient.invalidateQueries({ queryKey: uncategorizedCountKey }));
    await settle();
  }

  beforeEach(() => {
    server.seed('/categories', [GROCERIES_TOP]);
    server.seed(MERCHANTS, merchants);
  });

  // [G1] a caught-up user (resolved server 0) skips the whole-history walk and the button hides;
  // [G2] a backlog (count > 0) runs the walk and shows the button.
  it.each([
    [0, 0, false],
    [5, 1, true],
  ])('a resolved server count of %i sends %i shops request(s); button shown: %s', async (count, requests, shown) => {
    server.seed(COUNT, { count });
    await renderUncategorizedTab();
    expect(server.sentUnder('GET', MERCHANTS)).toHaveLength(requests);
    expect(screen.queryByTestId(FILE_BY_SHOP) !== null).toBe(shown);
  });

  // [A3] The shops gate and the buttons read the same fallback. Fail-on-revert: gate the shops
  // request on the server count alone → no shops request, no "File by shop".
  it('[A3] with unfiled rows loaded, the shops are fetched and both filing buttons show', async () => {
    server.fail(COUNT, 500);
    seedFeed(UNCATEGORIZED_FEED, [txn({ transaction_id: 't1', category: null })]);
    await renderUncategorizedTab();
    await countFailed();
    expect(server.sentUnder('GET', MERCHANTS)).toHaveLength(1);
    expect(screen.getByTestId(APPLY_RULES)).toBeTruthy();
    expect(await screen.findByTestId(FILE_BY_SHOP)).toBeTruthy();
  });

  // [A5] A failed shops request leaves "File by shop" hidden, but "Apply my rules" stays.
  it('[A5] a failed shops request hides only "File by shop"', async () => {
    server.seed(COUNT, { count: 5 });
    server.fail(MERCHANTS, 500);
    seedFeed(UNCATEGORIZED_FEED, [txn({ transaction_id: 't1', category: null })]);
    await renderUncategorizedTab();
    expect(server.sentUnder('GET', MERCHANTS)).toHaveLength(1);
    expect(screen.getByTestId(APPLY_RULES)).toBeTruthy();
    expect(screen.queryByTestId(FILE_BY_SHOP)).toBeNull();
  });

  // [A6] Mid-session the count drops to 0 while the loaded page was already empty (the rows sat
  // deeper in history). Both buttons go. Fail-on-revert: drop `uncategorizedCount > 0` from the
  // "Apply my rules" gate → it stays up over "All caught up".
  it('[A6] both buttons hide when the count drops to 0 mid-session', async () => {
    server.seed(COUNT, { count: 4 });
    seedFeed(UNCATEGORIZED_FEED, [], 'c1');
    await renderUncategorizedTab();
    expect(screen.getByTestId(APPLY_RULES)).toBeTruthy();
    expect(screen.getByTestId(FILE_BY_SHOP)).toBeTruthy();

    await setCount(0);
    expect(await screen.findByText('All caught up')).toBeTruthy();
    expect(screen.queryByTestId(APPLY_RULES)).toBeNull();
    expect(screen.queryByTestId(FILE_BY_SHOP)).toBeNull();
  });

  // [A7] Mid-session the count goes 0 → 3 with an empty loaded page. "Apply my rules" appears on
  // the server number alone. Fail-on-revert: gate it on the loaded rows → it never shows.
  it('[A7] "Apply my rules" appears when the count rises above 0 with nothing loaded', async () => {
    server.seed(COUNT, { count: 0 });
    await renderUncategorizedTab();
    expect(screen.queryByTestId(APPLY_RULES)).toBeNull();

    await setCount(3);
    expect(await screen.findByTestId(APPLY_RULES)).toBeTruthy();
    expect(screen.queryByText('All caught up')).toBeNull();
  });
});

// WHIT-501 — the "two-scan skew": the badge says there ARE unfiled charges but the loaded pages
// show none, so the tab explains itself rather than going blank. A live cursor → "More to load"
// (deep rows a Load More away); no more pages (stale/skewed badge) → "Nothing to show yet".
it.each([
  [639, 'deep-cursor', 'More to load', 'All caught up'],
  [3, null, 'Nothing to show yet', 'More to load'],
])('an empty page with a badge of %i and cursor %j shows "%s", not "%s"', async (count, cursor, shown, absent) => {
  server.seed(COUNT, { count });
  seedFeed(UNCATEGORIZED_FEED, [], cursor);
  await renderUncategorizedTab();
  expect(await screen.findByText(shown)).toBeTruthy();
  expect(screen.queryByText(absent)).toBeNull();
});
