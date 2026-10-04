// WHIT-686 QA — the Uncategorised tab's count gates when the whole-history count request FAILS.
// The moved suites only cover "still loading" (a held request). A failed request also leaves the
// count undefined, and every consumer must then fall back to the loaded rows — never to 0, which
// would hide the badge, the dot and the filing buttons, or claim "All caught up" over unfiled history.
// Also: the filing buttons react to the count changing mid-session, and a failed shops request
// hides only "File by shop".
import { it, expect, jest, beforeEach, describe } from '@jest/globals';
import React from 'react';
import { screen, fireEvent, within, waitFor } from '@testing-library/react-native';
import { txn } from './factory';

jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ openMultiPicker: jest.fn(), showToast: jest.fn(), openPicker: jest.fn(), setSheet: jest.fn() }) };
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
import { GROCERIES_TOP } from './support/categories';
import { useTestQueryClient, renderWithQueries, refreshInAct, settle } from './support/renderWithQueries';
import { queryClient } from '../queryClient';
import { uncategorizedCountKey, uncategorizedFeedKey } from '../queries';

const server = installFakeServer();
useTestQueryClient();

const FEED = '/transactions/feed';
const UNCATEGORIZED_FEED = '/transactions/uncategorized/feed';
const RECENT = '/transactions';
const COUNT = '/transactions/uncategorized/count';
const MERCHANTS = '/transactions/uncategorized/merchants';
const FILE_BY_SHOP = 'transactions-file-by-shop';
const APPLY_RULES = 'transactions-apply-rules';

const merchants = {
  unfiled: 20,
  groups: [{ merchant: 'Coles', rulePattern: 'coles', groupedBy: 'merchant', count: 20, samples: ['COLES 1'], firstDate: null, lastDate: null, alsoCatches: [] }],
  ungrouped: { count: 0, samples: [] },
};

const seedFeed = (path: string, transactions: unknown[], nextCursor: string | null = null) =>
  server.seed(path, { transactions, nextCursor });
const countFailed = () => waitFor(() => expect(queryClient.getQueryState(uncategorizedCountKey)?.status).toBe('error'));

const barProps: React.ComponentProps<typeof TabBar> = {
  state: { index: 0, routes: [{ key: 'transactions', name: 'transactions' }] },
  navigation: { emit: () => ({ defaultPrevented: false }), navigate: jest.fn() },
};

async function renderUncategorizedTab() {
  await renderWithQueries(<Transactions />);
  fireEvent.press(screen.getByTestId('tab-uncategorized'));
  await settle();
}

async function setCount(count: number) {
  server.seed(COUNT, { count });
  await refreshInAct(() => queryClient.invalidateQueries({ queryKey: uncategorizedCountKey }));
  await settle();
}

beforeEach(() => {
  resetAuth();
  server.seed('/categories', [GROCERIES_TOP]);
  server.seed(MERCHANTS, merchants);
});

describe('the count request fails → fall back to the loaded rows', () => {
  // [A1] Fail-on-revert: fall back to 0 instead of the local count → the badge loses its "2".
  it('[A1] the Uncategorized badge shows the local count when the count request fails', async () => {
    server.fail(COUNT, 500);
    seedFeed(FEED, [txn({ transaction_id: 't1', category: null }), txn({ transaction_id: 't2', category: null })]);
    await renderWithQueries(<Transactions />);
    await countFailed();
    expect(within(screen.getByTestId('tab-uncategorized')).getByText('2')).toBeTruthy();
  });

  // [A2] Fail-on-revert: treat a failed count as 0 → "All caught up" over unknown history.
  it('[A2] never claims "All caught up" when the count request fails on an empty tab', async () => {
    server.fail(COUNT, 500);
    await renderUncategorizedTab();
    await countFailed();
    expect(queryClient.getQueryState(uncategorizedFeedKey)?.status).toBe('success');
    expect(screen.queryByText('All caught up')).toBeNull();
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

  // [A4] Fail-on-revert: drive the dot off a failed count as 0 → the dot hides.
  it('[A4] the nav-bar dot falls back to the recent window when the count request fails', async () => {
    server.fail(COUNT, 500);
    server.seed(RECENT, [txn({ category: null, counts_to_budget: true })]);
    await renderWithQueries(<TabBar {...barProps} />);
    await countFailed();
    expect(screen.getByTestId('tab-uncat-dot')).toBeTruthy();
  });
});

describe('the filing buttons follow the live data', () => {
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
