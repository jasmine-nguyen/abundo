// WHIT-552 — GAP tests: the SCREEN's wiring of the "File by shop" fetch gate, adversarial to the
// implementer's hook test (uncategorizedMerchantsHook.screen.test.tsx, which locks the hook's OWN
// gate) and to fileByShopButton.screen.test.tsx. Nobody else proves the screen actually feeds
// `uncategorizedCount > 0` INTO the hook. These do, by whether the shops request goes out:
//   [G1] resolved server 0 → no shops request (caught-up user skips the walk) AND the button is
//        hidden — the fetch and the button agree.
//   [G2] resolved server count > 0 → shops requested AND the button shows.
//   [G3] server count still loading + local unfiled rows present → uncategorizedCount falls back to
//        the LOCAL count (> 0) → shops requested. Guards that the gate reads the SAME
//        `serverCount ?? local` the button does, not `serverCount > 0` (which would be false here).
//   [G4] server count still loading + NO local unfiled rows → count 0 → no shops request.
//   [G5] count flips 0 -> >0 mid-session → the gate turns the walk ON and the button appears.
//   [G6] count flips >0 -> 0 (last shop filed) → the gate turns the walk OFF and the button hides,
//        even though the cached shop list lingers (react-query keeps disabled-query data).
// Fail-on-revert: reverting `useUncategorizedMerchants(uncategorizedCount > 0)` back to
// `useUncategorizedMerchants()` sends the shops request in G1/G4 and the "none sent" checks fail.
// The screen and its data code are real, over the pretend server (WHIT-686).
import { it, expect, jest, beforeEach, describe } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { txn } from './factory';

// Real selectors (countUncategorized / isUncategorized / transactionGroups); only useAppContext stubbed.
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ openMultiPicker: jest.fn(), showToast: jest.fn(), openPicker: jest.fn(), setSheet: jest.fn() }) };
});
jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => {
  const ReactLib = require('react');
  return { useFocusEffect: (cb: () => void) => ReactLib.useEffect(() => cb(), [cb]), useRouter: () => ({ push: jest.fn() }) };
});

import Transactions from '../../app/(tabs)/transactions';
import { resetAuth } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { GROCERIES_TOP } from './support/categories';
import { useTestQueryClient, renderWithQueries, WithQueries, refreshInAct, settle, loaded } from './support/renderWithQueries';
import { queryClient } from '../queryClient';
import { uncategorizedCountKey, uncategorizedFeedKey } from '../queries';

const server = installFakeServer();
useTestQueryClient();

const UNCATEGORIZED_FEED = '/transactions/uncategorized/feed';
const COUNT = '/transactions/uncategorized/count';
const MERCHANTS = '/transactions/uncategorized/merchants';
// Only 'groceries' is a real category → every other/`null` row is Uncategorized.

const merchants = (over: Record<string, unknown> = {}) => ({
  unfiled: 20,
  groups: [{ merchant: 'Coles', rulePattern: 'coles', groupedBy: 'merchant', count: 20, samples: ['COLES 1'], firstDate: null, lastDate: null, alsoCatches: [] }],
  ungrouped: { count: 0, samples: [] },
  ...over,
});

const BUTTON = 'transactions-file-by-shop';
const shopsRequests = () => server.sentUnder('GET', MERCHANTS);
const seedUncategorizedFeed = (transactions: unknown[]) => server.seed(UNCATEGORIZED_FEED, { transactions, nextCursor: null });

async function renderTab() {
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
  server.seed(MERCHANTS, merchants());
});

describe('WHIT-552 screen wiring of the File-by-shop fetch gate', () => {
  // [G1] caught-up user: resolved server 0. The walk must NOT run, and the button hides.
  it('[G1] resolved server 0 → no shops request AND button hidden', async () => {
    server.seed(COUNT, { count: 0 });
    await renderTab();
    expect(shopsRequests()).toHaveLength(0);         // the walk is gated OFF for a caught-up user
    expect(screen.queryByTestId(BUTTON)).toBeNull(); // and the button agrees
  });

  // [G2] backlog: resolved server count > 0 → walk runs, button shows.
  it('[G2] resolved server count > 0 → shops requested AND button shown', async () => {
    server.seed(COUNT, { count: 5 });
    await renderTab();
    expect(shopsRequests()).toHaveLength(1);
    expect(screen.getByTestId(BUTTON)).toBeTruthy();
  });

  // [G3] server count still loading + local unfiled rows → count = local (> 0) → walk runs.
  // Fail-on-revert-of-intent: had the gate read `serverCount > 0` this would stay off; it reads the
  // same `serverCount ?? local` the button gate does, so it (and the button) turn on here.
  it('[G3] server count loading + local unfiled rows → shops requested AND button shown', async () => {
    const held = server.hold(COUNT);
    seedUncategorizedFeed([txn({ transaction_id: 't1', category: null })]);
    render(<WithQueries><Transactions /></WithQueries>);
    fireEvent.press(screen.getByTestId('tab-uncategorized'));
    expect(await screen.findByTestId(BUTTON)).toBeTruthy();
    expect(shopsRequests()).toHaveLength(1);
    held.release();
    await settle();
  });

  // [G4] server count still loading + NO local unfiled rows → count 0 → walk gated off, button hidden.
  it('[G4] server count loading + no local unfiled rows → no shops request AND button hidden', async () => {
    const held = server.hold(COUNT);
    seedUncategorizedFeed([txn({ transaction_id: 't1', category: 'groceries' })]); // filed row → local count 0
    render(<WithQueries><Transactions /></WithQueries>);
    fireEvent.press(screen.getByTestId('tab-uncategorized'));
    await loaded(uncategorizedFeedKey);
    expect(shopsRequests()).toHaveLength(0);
    expect(screen.queryByTestId(BUTTON)).toBeNull();
    held.release();
    await settle();
  });

  // [G5] mid-session 0 -> >0 (a cross-device charge arrives, the count refetches): the gate flips
  // the walk ON. Once the shops resolve the button appears.
  it('[G5] count flips 0 -> >0 → shops requested AND button appears', async () => {
    server.seed(COUNT, { count: 0 });
    await renderTab();
    expect(shopsRequests()).toHaveLength(0);
    expect(screen.queryByTestId(BUTTON)).toBeNull();

    await setCount(3);
    expect(await screen.findByTestId(BUTTON)).toBeTruthy();
    expect(shopsRequests()).toHaveLength(1);
  });

  // [G6] mid-session >0 -> 0 (last shop filed → count refetches to 0). React-query still holds the
  // last shop list (a disabled query keeps its data), yet the gate turns the walk off and the
  // button hides — no stale "File by shop" over a caught-up tab.
  it('[G6] count flips >0 -> 0 → no new shops request AND button hides despite stale cached shops', async () => {
    server.seed(COUNT, { count: 4 });
    seedUncategorizedFeed([txn({ transaction_id: 't1', category: null })]);
    await renderTab();
    expect(shopsRequests()).toHaveLength(1);
    expect(screen.getByTestId(BUTTON)).toBeTruthy();

    // last shop filed: the list empties and the server count resolves to 0
    seedUncategorizedFeed([]);
    await refreshInAct(() => queryClient.invalidateQueries({ queryKey: uncategorizedFeedKey }));
    await setCount(0);
    expect(screen.queryByTestId(BUTTON)).toBeNull();          // button hidden
    expect(shopsRequests()).toHaveLength(1);                  // walk gated off, nothing refetched
  });
});
