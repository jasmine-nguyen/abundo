// WHIT-686 QA (slice 1) — the transaction detail screen over the pretend server: the checks the
// moved suites lost or never had once the real screen data code runs. The old mock made the
// Transactions-tab composite throw if the detail screen mounted it (WHIT-614); here that is a
// check on the real cache and requests. Plus: Retry really recovers, the passive uncategorised
// read never fetches, a failed feed over a recent-list row stays cache-first, and late rules /
// budgets fill in.
import { it, expect, jest, beforeEach } from '@jest/globals';
import { setParams, resetRouter } from './support/routerMock';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { txn } from './factory';

jest.mock('../context', () =>
  require('./support/contextMock').realContextWith(() => ({ applyTransactionEdit: jest.fn(), showToast: jest.fn(), openPicker: jest.fn(), deleteTransaction: jest.fn() })),
);
jest.mock('../auth', () => require('./support/authMock').authMockModule());

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import TransactionDetail from '../../app/transaction/[id]';
import { resetAuth, setAuthStatus } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient, renderWithQueries, refreshInAct, WithQueries } from './support/renderWithQueries';
import { queryClient } from '../queryClient';
import { transactionsSearchKey, uncategorizedFeedKey } from '../queryKeys';
import { COFFEE_RECORD } from './support/categories';

const server = installFakeServer();
useTestQueryClient();

const ROW = txn({ transaction_id: 't1', category: 'coffee', amount: -130 });

beforeEach(() => {
  resetRouter();
  setParams({ id: 't1' });
  resetAuth();
  server.seed('/categories', [{ ...COFFEE_RECORD, parent: null }]);
  server.seed('/transactions/feed', { transactions: [ROW], nextCursor: null });
});

// [A1] WHIT-614 at screen level: the detail screen must use its own composite, never the
// Transactions-tab one (which sets up the search query and reads balances).
it('[A1] the detail screen sets up no search query and reads neither search nor balances', async () => {
  await renderWithQueries(<TransactionDetail />);
  expect(screen.getByText('Woolworths')).toBeTruthy();
  expect(queryClient.getQueryCache().findAll({ queryKey: transactionsSearchKey })).toHaveLength(0);
  expect(server.sentUnder('GET', '/transactions/search')).toHaveLength(0);
  expect(server.sentUnder('GET', '/accounts/balances')).toHaveLength(0);
});

// [A2] Retry recovers the screen, not just fires a request.
it('[A2] a first-open feed failure → Retry → the charge shows and the error goes', async () => {
  server.once('GET', '/transactions/feed', { status: 500 });
  await renderWithQueries(<TransactionDetail />);
  expect(screen.getByTestId('transaction-error')).toBeTruthy();

  await refreshInAct(() => fireEvent.press(screen.getByTestId('transaction-retry')));

  expect(await screen.findByText('Woolworths')).toBeTruthy();
  expect(screen.queryByTestId('transaction-error')).toBeNull();
});

// [A3] Retry after a taxonomy failure re-reads the categories too.
it('[A3] Retry after a categories failure re-reads /categories', async () => {
  server.seed('/transactions/feed', { transactions: [], nextCursor: null });
  server.once('GET', '/categories', { status: 500 });
  await renderWithQueries(<TransactionDetail />);
  expect(screen.getByTestId('transaction-error')).toBeTruthy();
  const before = server.sent('GET', '/categories').length;

  await refreshInAct(() => fireEvent.press(screen.getByTestId('transaction-retry')));

  await waitFor(() => expect(server.sent('GET', '/categories').length).toBe(before + 1));
  await waitFor(() => expect(screen.queryByTestId('transaction-error')).toBeNull());
});

// [A4] The uncategorised feed is read passively: a row already in its cache resolves, and the
// detail screen never starts that whole-history scan itself.
it('[A4] resolves a row only in the uncategorised cache without fetching that feed', async () => {
  server.seed('/transactions/feed', { transactions: [], nextCursor: null });
  queryClient.setQueryData(uncategorizedFeedKey, {
    pages: [{ transactions: [txn({ transaction_id: 't1', category: null, merchant_name: 'Deep Unfiled' })], nextCursor: null }],
    pageParams: [undefined],
  });
  await renderWithQueries(<TransactionDetail />);
  expect(screen.getByText('Deep Unfiled')).toBeTruthy();
  expect(server.sentUnder('GET', '/transactions/uncategorized/feed')).toHaveLength(0);
});

// [A4b] A cold open (nothing cached) still never starts the uncategorised whole-history scan.
it('[A4b] a cold open never fetches the uncategorised feed', async () => {
  await renderWithQueries(<TransactionDetail />);
  expect(screen.getByText('Woolworths')).toBeTruthy();
  expect(server.sentUnder('GET', '/transactions/uncategorized/feed')).toHaveLength(0);
});

// [A5] Cache-first across the resolver's union: the feed failing while the recent list has the
// row shows the row, not the error.
it('[A5] the feed fails but the recent list has the row → row shows, no error', async () => {
  server.fail('/transactions/feed', 500);
  server.seed('/transactions', [ROW]);
  await renderWithQueries(<TransactionDetail />);
  expect(screen.getByText('Woolworths')).toBeTruthy();
  expect(screen.queryByTestId('transaction-error')).toBeNull();
});

// [A6] A rule line held back while rules load fills in with the NAMED rule once they arrive.
it('[A6] rules arriving late fill in the named rule line', async () => {
  server.seed('/transactions/feed', { transactions: [txn({ transaction_id: 't1', category: 'coffee', filed_by_rule: 'r1' })], nextCursor: null });
  server.seed('/rules', [{ id: 'r1', field: 'description', operator: 'contains', value: 'COLES', categoryId: 'coffee' }]);
  const held = server.hold('/rules');
  render(<WithQueries><TransactionDetail /></WithQueries>);
  await screen.findByText('Woolworths');
  expect(screen.queryByText('Filed automatically by one of your rules')).toBeNull();

  await refreshInAct(() => held.release());
  expect(await screen.findByText('Filed by your rule: contains "COLES"')).toBeTruthy();
});

// [A7] Budgets arriving after the row: the spread prompt appears once the over-budget rollup lands.
it('[A7] the spread prompt appears once late budgets show the category over', async () => {
  server.seed('/budgets', { coffee: { target: 100, posted: 130, pending: 0 } });
  const held = server.hold('/budgets');
  render(<WithQueries><TransactionDetail /></WithQueries>);
  await screen.findByText('Woolworths');
  expect(screen.queryByTestId('transaction-spread')).toBeNull();

  await refreshInAct(() => held.release());
  expect(await screen.findByTestId('transaction-spread')).toBeTruthy();
});

// [A8] Signed out: the detail screen sends no reads.
it('[A8] signed out → no feed or categories read goes out', async () => {
  setAuthStatus('anon');
  await renderWithQueries(<TransactionDetail />);
  expect(server.sentUnder('GET', '/transactions')).toHaveLength(0);
  expect(server.sent('GET', '/categories')).toHaveLength(0);
});
