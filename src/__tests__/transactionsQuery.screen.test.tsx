// WHIT-190a — the Transactions list on the real query layer: rows come from the
// auth-gated ['transactions'] query (not fetched before login), a transient 5xx
// self-heals, a sustained failure shows an inline Retry, cache-first on revisit.
// ../api + ../auth + expo-router mocked; ../context PARTIALLY mocked (real selectors,
// stubbed useAppContext for TransactionRow + retryLoad) so ../queries' real imports
// still resolve; the screen renders under a real QueryClientProvider.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

let mockAuthStatus = 'authed';
const mockAuthListeners = new Set<() => void>();
jest.mock('../auth', () => ({
  getStatus: () => mockAuthStatus,
  subscribe: (l: () => void) => {
    mockAuthListeners.add(l);
    return () => mockAuthListeners.delete(l);
  },
}));
function setAuth(next: string) {
  mockAuthStatus = next;
  mockAuthListeners.forEach((l) => l());
}

const mockFetchTransactions = jest.fn<() => Promise<unknown>>();
const mockFetchCategories = jest.fn<() => Promise<unknown>>();
jest.mock('../api', () => ({
  fetchTransactions: () => mockFetchTransactions(),
  fetchCategories: () => mockFetchCategories(),
}));

const CATS = [{ id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#7FD49B', recent: 0 }];
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return {
    ...actual,
    useAppContext: () => ({ retryLoad: jest.fn(), category: (id: string | null) => CATS.find((c) => c.id === id) }),
  };
});

jest.mock('expo-router', () => {
  const ReactLib = require('react');
  return { useFocusEffect: (cb: () => void) => ReactLib.useEffect(() => cb(), [cb]) };
});

import Transactions from '../../app/(tabs)/transactions';

const TXNS = [{
  transaction_id: 't1', date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'WOOLWORTHS', merchant_name: 'Woolworths', amount: -42, account_id: 'a1',
  account_name: 'ANZ', category: 'groceries', status: 'posted', type: 'purchase', counts_to_budget: true,
}];

function makeClient(retry: boolean | number = false) {
  return new QueryClient({ defaultOptions: { queries: { retry, retryDelay: 1, staleTime: 60_000, gcTime: Infinity } } });
}
function renderTransactions(client = makeClient()) {
  return render(React.createElement(QueryClientProvider, { client }, React.createElement(Transactions)));
}

beforeEach(() => {
  mockAuthStatus = 'authed';
  mockAuthListeners.clear();
  mockFetchTransactions.mockReset().mockResolvedValue(TXNS);
  mockFetchCategories.mockReset().mockResolvedValue(CATS);
});

it('renders transaction rows from the query', async () => {
  renderTransactions();
  expect(await screen.findByText('-$42.00')).toBeTruthy(); // the query-fed row rendered
  expect(mockFetchTransactions).toHaveBeenCalledTimes(1);
  expect(mockFetchCategories).toHaveBeenCalledTimes(1);
});

it('shows a spinner first, then the rows (cache-first)', async () => {
  renderTransactions();
  expect(screen.getByTestId('transactions-loading')).toBeTruthy();
  expect(await screen.findByText('-$42.00')).toBeTruthy();
});

it('a transient 5xx retries and self-heals — no error shown', async () => {
  mockFetchTransactions.mockReset().mockRejectedValueOnce(new Error('API error: 503')).mockResolvedValue(TXNS);
  renderTransactions(makeClient(2));
  expect(await screen.findByText('-$42.00')).toBeTruthy();
  expect(screen.queryByTestId('transactions-error')).toBeNull();
  expect(mockFetchTransactions).toHaveBeenCalledTimes(2);
});

it('a sustained failure shows the inline error, and Retry recovers', async () => {
  mockFetchTransactions.mockReset().mockRejectedValue(new Error('API error: 503'));
  renderTransactions(makeClient(false));
  expect(await screen.findByTestId('transactions-error')).toBeTruthy();

  mockFetchTransactions.mockReset().mockResolvedValue(TXNS);
  fireEvent.press(screen.getByTestId('transactions-retry'));
  expect(await screen.findByText('-$42.00')).toBeTruthy();
});

it('does not fetch before login, then fires on auth flip to authed', async () => {
  mockAuthStatus = 'anon';
  renderTransactions();
  expect(mockFetchTransactions).not.toHaveBeenCalled();

  await act(async () => {
    setAuth('authed');
  });
  expect(await screen.findByText('-$42.00')).toBeTruthy();
  expect(mockFetchTransactions).toHaveBeenCalled();
});
