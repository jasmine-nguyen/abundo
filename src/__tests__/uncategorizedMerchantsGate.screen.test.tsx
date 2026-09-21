// WHIT-552 — GAP tests: the SCREEN's wiring of the "File by shop" fetch gate, adversarial to the
// implementer's hook test (uncategorizedMerchantsHook.screen.test.tsx, which locks the hook's OWN
// gate) and to fileByShopButton.screen.test.tsx (which mocks the hook and ignores its argument).
// Nobody proves the screen actually feeds `uncategorizedCount > 0` INTO the hook. These do:
//   [G1] resolved server 0 → hook called with enabled=false (caught-up user skips the walk) AND
//        the button is hidden — the fetch and the button agree in the same render.
//   [G2] resolved server count > 0 → hook called with enabled=true AND the button shows.
//   [G3] serverCount undefined + local unfiled rows present → uncategorizedCount falls back to the
//        LOCAL count (> 0) → hook enabled=true. Guards that the gate reads the SAME
//        `serverCount ?? local` the button does, not `serverCount > 0` (which would be false here).
//   [G4] serverCount undefined + NO local rows → count 0 → hook enabled=false (nothing to walk).
//   [G5] count flips 0 -> >0 mid-session → the gate turns the walk ON and the button appears.
//   [G6] count flips >0 -> 0 (last shop filed) → the gate turns the walk OFF and the button hides,
//        even if a stale cached shop list lingers (react-query keeps disabled-query data).
// Fail-on-revert: reverting `useUncategorizedMerchants(uncategorizedCount > 0)` back to
// `useUncategorizedMerchants()` makes the recorded arg `undefined` → every enabled-arg assertion
// here fails (G1/G4 expect false, G2/G3/G5 expect true).
import { it, expect, jest, beforeEach, describe } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { txn } from './factory';

let mockTx: Record<string, unknown>;
let mockServerCount: number | undefined;
let mockMerchants: unknown;
// Records the `enabled` arg the screen passes. Return value is driven by mockMerchants (NOT by the
// arg) so the arg assertions and the button assertions are independent axes we can cross-check.
const mockUseMerchants = jest.fn((_enabled?: boolean) => ({ merchants: mockMerchants, isLoading: false, isError: false }));

jest.mock('../queries', () => ({
  useTransactionsScreenData: () => mockTx,
  useUncategorizedCount: () => mockServerCount,
  useUncategorizedMerchants: (enabled?: boolean) => mockUseMerchants(enabled),
}));

// Real selectors (countUncategorized / isUncategorized / transactionGroups); only useAppContext stubbed.
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ openMultiPicker: jest.fn(), showToast: jest.fn(), openPicker: jest.fn(), setSheet: jest.fn() }) };
});
jest.mock('expo-router', () => {
  const ReactLib = require('react');
  return { useFocusEffect: (cb: () => void) => ReactLib.useEffect(() => cb(), [cb]), useRouter: () => ({ push: jest.fn() }) };
});

import Transactions from '../../app/(tabs)/transactions';

// Resolver: only 'groceries' is a real category → every other/`null` row is Uncategorized.
const category = (id: string | null) => (id === 'groceries' ? ({ id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#7FD49B', recent: 0 }) : undefined);

function txData(over: Record<string, unknown> = {}) {
  return {
    transactions: [], category, balances: new Map(),
    isLoading: false, isError: false, isFetching: false, refetch: jest.fn(), refetchStale: jest.fn(),
    refetchList: jest.fn(() => Promise.resolve()), refreshLiveBalances: jest.fn(() => Promise.resolve()),
    hasMore: false, loadMore: jest.fn(), isLoadingMore: false, ...over,
  };
}

const merchants = (over: Record<string, unknown> = {}) => ({
  unfiled: 20,
  groups: [{ merchant: 'Coles', rulePattern: 'coles', groupedBy: 'merchant', count: 20, samples: ['COLES 1'], firstDate: null, lastDate: null, alsoCatches: [] }],
  ungrouped: { count: 0, samples: [] },
  ...over,
});

const BUTTON = 'transactions-file-by-shop';
const lastEnabled = () => mockUseMerchants.mock.calls[mockUseMerchants.mock.calls.length - 1][0];

function renderTab() {
  render(<Transactions />);
  fireEvent.press(screen.getByTestId('tab-uncategorized'));
}

beforeEach(() => {
  mockTx = txData();
  mockServerCount = undefined;
  mockMerchants = merchants();
  mockUseMerchants.mockClear();
});

describe('WHIT-552 screen wiring of the File-by-shop fetch gate', () => {
  // [G1] caught-up user: resolved server 0. The walk must NOT be enabled, and the button hides.
  it('[G1] resolved server 0 → hook enabled=false AND button hidden', () => {
    mockServerCount = 0;
    mockTx = txData({ transactions: [] });
    renderTab();
    expect(lastEnabled()).toBe(false);              // the walk is gated OFF for a caught-up user
    expect(screen.queryByTestId(BUTTON)).toBeNull(); // and the button agrees
  });

  // [G2] backlog: resolved server count > 0 → walk enabled, button shows.
  it('[G2] resolved server count > 0 → hook enabled=true AND button shown', () => {
    mockServerCount = 5;
    mockTx = txData({ transactions: [] });
    renderTab();
    expect(lastEnabled()).toBe(true);
    expect(screen.getByTestId(BUTTON)).toBeTruthy();
  });

  // [G3] serverCount undefined (loading) + local unfiled rows → count = local (> 0) → walk enabled.
  // Fail-on-revert-of-intent: had the gate read `serverCount > 0` this would be false; it reads the
  // same `serverCount ?? local` the button gate does, so it (and the button) turn on here.
  it('[G3] serverCount undefined + local unfiled rows → hook enabled=true AND button shown', () => {
    mockServerCount = undefined;
    mockTx = txData({ transactions: [txn({ transaction_id: 't1', category: null })] });
    renderTab();
    expect(lastEnabled()).toBe(true);
    expect(screen.getByTestId(BUTTON)).toBeTruthy();
  });

  // [G4] serverCount undefined + NO local unfiled rows → count 0 → walk gated off, button hidden.
  it('[G4] serverCount undefined + no local unfiled rows → hook enabled=false AND button hidden', () => {
    mockServerCount = undefined;
    mockTx = txData({ transactions: [txn({ transaction_id: 't1', category: 'groceries' })] }); // filed row → local count 0
    renderTab();
    expect(lastEnabled()).toBe(false);
    expect(screen.queryByTestId(BUTTON)).toBeNull();
  });

  // [G5] mid-session 0 -> >0 (a cross-device charge arrives, the count refetches): the gate flips
  // the walk ON. Once the shops resolve the button appears.
  it('[G5] count flips 0 -> >0 → hook re-enabled AND button appears', () => {
    mockServerCount = 0;
    mockTx = txData({ transactions: [] });
    mockMerchants = undefined; // nothing walked yet while gated off
    const { rerender } = render(<Transactions />);
    fireEvent.press(screen.getByTestId('tab-uncategorized'));
    expect(lastEnabled()).toBe(false);
    expect(screen.queryByTestId(BUTTON)).toBeNull();

    // count goes positive; the now-enabled walk resolves its shops
    mockServerCount = 3;
    mockMerchants = merchants();
    rerender(<Transactions />);
    expect(lastEnabled()).toBe(true);
    expect(screen.getByTestId(BUTTON)).toBeTruthy();
  });

  // [G6] mid-session >0 -> 0 (last shop filed → count refetches to 0). Even if react-query still
  // holds the last shop list (a disabled query keeps its data), the gate turns the walk off and the
  // button hides — no stale "File by shop" over a caught-up tab.
  it('[G6] count flips >0 -> 0 → hook disabled AND button hides despite stale cached shops', () => {
    mockServerCount = 4;
    mockTx = txData({ transactions: [txn({ transaction_id: 't1', category: null })] });
    mockMerchants = merchants();
    const { rerender } = render(<Transactions />);
    fireEvent.press(screen.getByTestId('tab-uncategorized'));
    expect(lastEnabled()).toBe(true);
    expect(screen.getByTestId(BUTTON)).toBeTruthy();

    // last shop filed: server count resolves to 0, list empties, but the shop cache lingers
    mockServerCount = 0;
    mockTx = txData({ transactions: [] });
    mockMerchants = merchants(); // stale cached shops still present
    rerender(<Transactions />);
    expect(lastEnabled()).toBe(false);              // walk gated off
    expect(screen.queryByTestId(BUTTON)).toBeNull(); // button hidden despite lingering shops
  });
});
