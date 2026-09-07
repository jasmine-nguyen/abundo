// WHIT-489 — adversarial GAPS for the "Balances up to date" success toast. These do NOT duplicate the
// implementer's three hook tests (usePullToRefresh.screen.test.tsx) or [G2] (pullToRefreshLiveBalances):
//   [N1] REGRESSION on the shared hook: the Transactions tab wires the hook WITHOUT a successMessage,
//        so a SUCCESSFUL pull there stays silent. Reddens if someone passes a message at that call site.
//   [N2] The exact "feels broken" case: the live number is UNCHANGED (same -$100.00 in and out) — the
//        toast must STILL fire, because that is the only signal the pull ran.
//   [N3] allSettled independence: the LIST refetch fails but the balance succeeds → success toast STILL
//        fires (the toast is gated on the balance call, never the list outcome).
//   [N4] Empty "No accounts yet" state is a valid pull target → a successful pull still confirms.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { RefreshControl } from 'react-native';
import { render, screen, act, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

let mockAuthStatus = 'authed';
jest.mock('../auth', () => ({ getStatus: () => mockAuthStatus, subscribe: () => () => {} }));

const mockFetchTransactionsFeed = jest.fn<(cursor?: string) => Promise<unknown>>();
const mockFetchCategories = jest.fn<() => Promise<unknown>>();
const mockFetchAccountBalances = jest.fn<() => Promise<unknown>>();
const mockRefreshAccountBalances = jest.fn<() => Promise<unknown>>();
const mockFetchUncategorizedCount = jest.fn<() => Promise<number>>();
const mockShowToast = jest.fn<(m: string) => void>();
jest.mock('../api', () => ({
  fetchTransactionsFeed: (cursor?: string) => mockFetchTransactionsFeed(cursor),
  fetchCategories: () => mockFetchCategories(),
  fetchTransactions: () => Promise.resolve([]),
  fetchAccountBalances: () => mockFetchAccountBalances(),
  refreshAccountBalances: () => mockRefreshAccountBalances(),
  fetchUncategorizedCount: () => mockFetchUncategorizedCount(),
}));

const CATS = [{ id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#7FD49B', recent: 0 }];
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return {
    ...actual,
    useAppContext: () => ({ retryLoad: jest.fn(), openMultiPicker: jest.fn(), showToast: mockShowToast, category: (id: string | null) => CATS.find((c) => c.id === id) }),
  };
});

jest.mock('expo-router', () => {
  const ReactLib = require('react');
  return { useFocusEffect: (cb: () => void) => ReactLib.useEffect(() => cb(), [cb]), useRouter: () => ({ push: jest.fn() }) };
});

import Accounts from '../../app/(tabs)/accounts';
import Transactions from '../../app/(tabs)/transactions';

const TXNS = [{
  transaction_id: 't1', date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'WOOLWORTHS', merchant_name: 'Woolworths', amount: -42, account_id: 'a1',
  account_name: 'ANZ', category: 'groceries', status: 'posted', type: 'purchase', counts_to_budget: true,
}];

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000, gcTime: Infinity } } });
}
const rc = () => screen.UNSAFE_getByType(RefreshControl);
const pull = async () => { await act(async () => { rc().props.onRefresh(); }); };
// Let the balance promise's .then/.catch microtasks flush so a (wrongly) wired toast would have fired.
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

beforeEach(() => {
  mockAuthStatus = 'authed';
  mockFetchTransactionsFeed.mockReset().mockResolvedValue({ transactions: TXNS, nextCursor: null });
  mockFetchCategories.mockReset().mockResolvedValue(CATS);
  mockFetchAccountBalances.mockReset().mockResolvedValue([{ account_id: 'a1', amount: -100 }]);
  mockRefreshAccountBalances.mockReset().mockResolvedValue([{ account_id: 'a1', amount: -100 }]);
  mockFetchUncategorizedCount.mockReset().mockResolvedValue(0);
  mockShowToast.mockReset();
});

describe('pull-to-refresh success-toast gaps (WHIT-489)', () => {
  // [N1] REGRESSION GUARD on the shared hook: the Transactions tab passes NO successMessage
  // (transactions.tsx call site), so a SUCCESSFUL pull there must stay completely silent — the
  // success toast is an Accounts-only affordance. Fail-on-revert: add 'Balances up to date' to the
  // transactions.tsx usePullToRefresh(...) call → this reddens.
  it('[N1] the Transactions tab stays SILENT on a successful pull', async () => {
    render(React.createElement(QueryClientProvider, { client: makeClient() }, React.createElement(Transactions)));
    expect(await screen.findByText('-$42.00')).toBeTruthy();

    await pull();
    await waitFor(() => expect(mockRefreshAccountBalances).toHaveBeenCalledTimes(1)); // the live call ran & succeeded
    await flush();
    expect(mockShowToast).not.toHaveBeenCalled(); // no 'Balances up to date', no failure toast — silent
  });

  // [N2] The exact "feels broken" case: the live refresh returns the SAME number the card already shows
  // (balance didn't move, or the server's 60s throttle handed back the stored value). The card is
  // unchanged (-$100.00 in and -$100.00 out) yet the toast MUST still fire — it is the only proof the
  // pull ran. Fail-on-revert: drop the successMessage arg in accounts.tsx → no toast → RED.
  it('[N2] an UNCHANGED balance still toasts "Balances up to date"', async () => {
    mockRefreshAccountBalances.mockResolvedValue([{ account_id: 'a1', amount: -100 }]); // same as stored
    render(React.createElement(QueryClientProvider, { client: makeClient() }, React.createElement(Accounts)));
    expect(await screen.findByText('-$100.00')).toBeTruthy();

    await pull();
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Balances up to date'));
    expect(screen.getByText('-$100.00')).toBeTruthy();  // number genuinely unchanged — this is the whole point
    expect(mockShowToast).not.toHaveBeenCalledWith('Could not refresh balances. Showing last saved.');
  });

  // [N3] allSettled independence: the LIST refetch fails on the pull (feed rejects) but the live balance
  // call succeeds → the success toast STILL fires. Proves the success confirmation is gated on the
  // BALANCE outcome alone, never on the list refetch. Fail-on-revert: drop the successMessage arg in
  // accounts.tsx → no toast → RED. (The list-failure setup is what makes the independence claim real:
  // the toast fires despite the feed refetch erroring.)
  it('[N3] toasts success even when the list refetch fails but the balance succeeds', async () => {
    render(React.createElement(QueryClientProvider, { client: makeClient() }, React.createElement(Accounts)));
    expect(await screen.findByText('-$100.00')).toBeTruthy();
    // The pull's list refetch now errors; the live balance call still resolves.
    mockFetchTransactionsFeed.mockReset().mockRejectedValue(new Error('API error: 503'));
    mockRefreshAccountBalances.mockResolvedValue([{ account_id: 'a1', amount: -250 }]);

    await pull();
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Balances up to date'));
    expect(screen.queryByTestId('accounts-error')).toBeNull(); // list kept last-good rows, not blanked
    expect(mockShowToast).not.toHaveBeenCalledWith('Could not refresh balances. Showing last saved.');
  });

  // [N4] The settled "No accounts yet" empty state is a valid pull target (accounts.tsx keeps the
  // RefreshControl live there, gated on !showSpinner not on row count). A successful pull from empty
  // must still confirm with the toast. Fail-on-revert: drop the successMessage arg in accounts.tsx → RED.
  it('[N4] a pull on the empty "No accounts yet" state still toasts success', async () => {
    mockFetchTransactionsFeed.mockReset().mockResolvedValue({ transactions: [], nextCursor: null }); // no accounts
    render(React.createElement(QueryClientProvider, { client: makeClient() }, React.createElement(Accounts)));
    expect(await screen.findByText('No accounts yet')).toBeTruthy();

    await pull();
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Balances up to date'));
    expect(screen.getByText('No accounts yet')).toBeTruthy(); // still empty; the pull just confirmed
  });
});
