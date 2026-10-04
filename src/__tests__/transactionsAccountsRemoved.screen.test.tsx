// WHIT-215 GAP (accounts-separate-tab) — the Accounts SEGMENT was lifted out of the Transactions
// screen into its own tab. The existing tests moved the account-card ASSERTIONS to
// accountsTab.screen.test.tsx but nothing locks that the segment is truly GONE from Transactions.
// These are the regression guards: no "Accounts" segment button, no account-view artifacts
// ("No accounts yet" empty state, the "—" pending-balance placeholder) ever render on the
// Transactions screen even with account-bearing data; and the "Select" header button shows on
// BOTH remaining segments (All + Uncategorized), not tied to a tab.
// The screen and its data code are real, over the pretend server (WHIT-686).
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { screen, fireEvent } from '@testing-library/react-native';

jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return {
    ...actual,
    useAppContext: () => ({ openMultiPicker: jest.fn(), showToast: jest.fn() }),
  };
});
jest.mock('../auth', () => require('./support/authMock').authMockModule());

jest.mock('expo-router', () => {
  const ReactLib = require('react');
  return {
    useFocusEffect: (cb: () => void) => ReactLib.useEffect(() => cb(), [cb]),
    useRouter: () => ({ push: jest.fn() }),
  };
});

import Transactions from '../../app/(tabs)/transactions';
import { resetAuth } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient, renderWithQueries } from './support/renderWithQueries';
import { GROCERIES_RECORD } from './support/categories';

const server = installFakeServer();
useTestQueryClient();
const ROW = {
  transaction_id: 't1', date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'WOOLWORTHS', merchant_name: 'Woolworths', amount: -42, account_id: 'a1',
  account_name: 'ANZ', category: 'groceries', status: 'posted', type: 'purchase', counts_to_budget: true,
};

const seedFeed = (transactions: unknown[]) => server.seed('/transactions/feed', { transactions, nextCursor: null });

beforeEach(() => {
  resetAuth();
  server.seed('/categories', [GROCERIES_RECORD]);
  server.seed('/accounts/balances', [{ account_id: 'a1', amount: -100 }]);
  seedFeed([ROW]);
});

it('renders only the "All" and "Uncategorized" segments — the "Accounts" segment is gone', async () => {
  await renderWithQueries(<Transactions />);
  expect(screen.getByText('-$42.00')).toBeTruthy();
  expect(screen.getByText('All')).toBeTruthy();
  expect(screen.getByText('Uncategorized')).toBeTruthy();
  expect(screen.queryByText('Accounts')).toBeNull(); // the segment was moved to its own tab
});

it('never shows the accounts-view artifacts, even with account-bearing transactions', async () => {
  // A single account's charges (and a live balance for it). On the old segment this drove an
  // account CARD + balance; on the Transactions screen there must be no card, no empty state, no
  // pending "—" placeholder.
  await renderWithQueries(<Transactions />);
  expect(screen.getByText('-$42.00')).toBeTruthy();
  expect(screen.queryByText('No accounts yet')).toBeNull();
  expect(screen.queryByText('—')).toBeNull();            // the account pending-balance placeholder
  expect(screen.queryByText('-$100.00')).toBeNull();      // the account card's balance
  expect(screen.queryByText('1 transaction')).toBeNull(); // the account card's txn-count subtitle
});

it('an empty transactions list on Transactions shows NO "No accounts yet" (that is the Accounts tab\'s state)', async () => {
  seedFeed([]);
  await renderWithQueries(<Transactions />);
  expect(screen.queryByText('No accounts yet')).toBeNull();
});

it('the "Select" header button shows on BOTH remaining segments (All and Uncategorized)', async () => {
  await renderWithQueries(<Transactions />);
  expect(screen.getByText('Select')).toBeTruthy();      // visible on the default "All" segment
  fireEvent.press(screen.getByText('Uncategorized'));
  expect(screen.getByText('Select')).toBeTruthy();      // still visible after switching segment
});
