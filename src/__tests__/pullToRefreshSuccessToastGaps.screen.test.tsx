// WHIT-489 — adversarial GAP for the "Balances up to date" success toast, beyond the hook tests
// (usePullToRefresh.screen.test.tsx) and [G2] (pullToRefreshLiveBalances):
//   [N2] The exact "feels broken" case: the live number is UNCHANGED (same -$100.00 in and out) — the
//        toast must STILL fire, because that is the only signal the pull ran.
// Real ../api over the fake server; ../auth + expo-router mocked; ../context PARTIALLY mocked.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { RefreshControl } from 'react-native';
import { render, screen, act, waitFor } from '@testing-library/react-native';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeClient } from './support/queryClient';
import { installFakeServer } from './support/fakeServer';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
import { resetAuth } from './support/authMock';

const mockShowToast = jest.fn<(m: string) => void>();

const mockCategories = [{ ...GROCERIES_RECORD, color: '#7FD49B' }];
jest.mock('../context', () => require('./support/contextMock').realContextWith(() => ({ retryLoad: jest.fn(), openMultiPicker: jest.fn(), showToast: mockShowToast, category: (id: string | null) => mockCategories.find((c) => c.id === id) })));

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import Accounts from '../../app/(tabs)/accounts';
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

beforeEach(() => {
  resetAuth();
  server.seed(FEED, { transactions: TXNS, nextCursor: null });
  server.seed('/categories', mockCategories);
  // The live refresh echoes the stored balances unless a test queues its own reply.
  server.seed(BALANCES, [{ account_id: 'a1', amount: -100 }]);
  mockShowToast.mockReset();
});

describe('pull-to-refresh success-toast gaps (WHIT-489)', () => {
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
});
