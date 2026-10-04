// WHIT-489 — adversarial GAPS for the "Balances up to date" success toast. These do NOT duplicate the
// implementer's three hook tests (usePullToRefresh.screen.test.tsx) or [G2] (pullToRefreshLiveBalances):
//   [N1] REGRESSION on the shared hook: the Transactions tab wires the hook WITHOUT a successMessage,
//        so a SUCCESSFUL pull there stays silent. Reddens if someone passes a message at that call site.
//   [N2] The exact "feels broken" case: the live number is UNCHANGED (same -$100.00 in and out) — the
//        toast must STILL fire, because that is the only signal the pull ran.
//   [N3] allSettled independence: the LIST refetch fails but the balance succeeds → success toast STILL
//        fires (the toast is gated on the balance call, never the list outcome).
//   [N4] Empty "No accounts yet" state is a valid pull target → a successful pull still confirms.
// Real ../api over the fake server; ../auth + expo-router mocked; ../context PARTIALLY mocked.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { RefreshControl } from 'react-native';
import { render, screen, act, waitFor } from '@testing-library/react-native';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeClient } from './support/queryClient';
import { installFakeServer } from './support/fakeServer';

let mockAuthStatus = 'authed';
jest.mock('../auth', () => ({
  getStatus: () => mockAuthStatus,
  subscribe: () => () => {},
  getAuthToken: async () => 'test-id-token',
}));

const mockShowToast = jest.fn<(m: string) => void>();

const mockCategories = [{ ...GROCERIES_RECORD, color: '#7FD49B', recent: 0 }];
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return {
    ...actual,
    useAppContext: () => ({ retryLoad: jest.fn(), openMultiPicker: jest.fn(), showToast: mockShowToast, category: (id: string | null) => mockCategories.find((c) => c.id === id) }),
  };
});

jest.mock('expo-router', () => {
  const ReactLib = require('react');
  return { useFocusEffect: (cb: () => void) => ReactLib.useEffect(() => cb(), [cb]), useRouter: () => ({ push: jest.fn() }) };
});

import Accounts from '../../app/(tabs)/accounts';
import Transactions from '../../app/(tabs)/transactions';
import { GROCERIES_RECORD } from './support/categories';

const server = installFakeServer();
const FEED = '/transactions/feed';
const BALANCES = '/accounts/balances';
const REFRESH = '/accounts/balances/refresh';

const TXNS = [{
  transaction_id: 't1', date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'WOOLWORTHS', merchant_name: 'Woolworths', amount: -42, account_id: 'a1',
  account_name: 'ANZ', category: 'groceries', status: 'posted', type: 'purchase', counts_to_budget: true,
}];

const rc = () => screen.UNSAFE_getByType(RefreshControl);
const pull = async () => { await act(async () => { rc().props.onRefresh(); }); };
// Let the balance promise's .then/.catch microtasks flush so a (wrongly) wired toast would have fired.
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

beforeEach(() => {
  mockAuthStatus = 'authed';
  server.seed(FEED, { transactions: TXNS, nextCursor: null });
  server.seed('/categories', mockCategories);
  // The live refresh echoes the stored balances unless a test queues its own reply.
  server.seed(BALANCES, [{ account_id: 'a1', amount: -100 }]);
  server.seed('/transactions/uncategorized/count', { count: 0 });
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
    await waitFor(() => expect(server.sent('POST', REFRESH)).toHaveLength(1)); // the live call ran & succeeded
    await flush();
    expect(mockShowToast).not.toHaveBeenCalled(); // no 'Balances up to date', no failure toast — silent
  });

  // [N2] The exact "feels broken" case: the live refresh returns the SAME number the card already shows
  // (balance didn't move, or the server's 60s throttle handed back the stored value). The card is
  // unchanged (-$100.00 in and -$100.00 out) yet the toast MUST still fire — it is the only proof the
  // pull ran. Fail-on-revert: drop the successMessage arg in accounts.tsx → no toast → RED.
  it('[N2] an UNCHANGED balance still toasts "Balances up to date"', async () => {
    server.once('POST', REFRESH, { body: [{ account_id: 'a1', amount: -100 }] }); // same as stored
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
    server.fail(FEED, 503);
    server.once('POST', REFRESH, { body: [{ account_id: 'a1', amount: -250 }] });

    await pull();
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Balances up to date'));
    expect(screen.queryByTestId('accounts-error')).toBeNull(); // list kept last-good rows, not blanked
    expect(mockShowToast).not.toHaveBeenCalledWith('Could not refresh balances. Showing last saved.');
  });

  // [N4] The settled "No accounts yet" empty state is a valid pull target (accounts.tsx keeps the
  // RefreshControl live there, gated on !showSpinner not on row count). A successful pull from empty
  // must still confirm with the toast. Fail-on-revert: drop the successMessage arg in accounts.tsx → RED.
  it('[N4] a pull on the empty "No accounts yet" state still toasts success', async () => {
    server.seed(FEED, { transactions: [], nextCursor: null }); // no accounts
    server.seed(BALANCES, []); // WHIT-643: a saved balance alone now makes a card
    server.once('POST', REFRESH, { body: [] });
    render(React.createElement(QueryClientProvider, { client: makeClient() }, React.createElement(Accounts)));
    expect(await screen.findByText('No accounts yet')).toBeTruthy();

    await pull();
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Balances up to date'));
    expect(screen.getByText('No accounts yet')).toBeTruthy(); // still empty; the pull just confirmed
  });
});
