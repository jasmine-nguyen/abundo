// WHIT-576 — QA gap tests for the Transactions-tab full-history search (screen half).
// transactionsSearchServer.screen.test.tsx locks the happy paths; these lock the transitions it
// doesn't: a stale server answer vs the live text [A1], clearing the box while the debounce still
// holds the old query [A2], a re-filed row dropping off the Uncategorized tab [A3], the pull spinner
// when only the search has rows [A4], and "No matches" never sharing the screen with Load More [A5].
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { RefreshControl } from 'react-native';
import { render, screen, fireEvent, act } from '@testing-library/react-native';

let mockTx: ReturnType<typeof transactionsScreenData>;
let mockServerCount: number | undefined;
const mockHookCalls: [string, string][] = [];
jest.mock('../queries', () => ({
  useTransactionsScreenData: (tab: string, serverQuery: string) => {
    mockHookCalls.push([tab, serverQuery]);
    return mockTx;
  },
  useUncategorizedCount: () => mockServerCount,
  useUncategorizedMerchants: () => ({ merchants: undefined, isLoading: false, isError: false }),
}));
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ openPicker: jest.fn(), openMultiPicker: jest.fn(), showToast: jest.fn(), setSheet: jest.fn() }) };
});
jest.mock('expo-router', () => {
  const ReactLib = require('react');
  return { useFocusEffect: (cb: () => void) => ReactLib.useEffect(() => cb(), [cb]), useRouter: () => ({ push: jest.fn() }) };
});

import Transactions from '../../app/(tabs)/transactions';
import { transactionsScreenData, idleSearch } from './support/transactionsScreenData';

const CAT = { id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#7FD49B', recent: 0 };
const category = (id: string | null) => (id === 'groceries' ? CAT : undefined);
const row = (id: string, merchant: string, amount: number, date = '2026-07-01', cat: string | null = null) => ({
  transaction_id: id, date, authorized_date: date, description: merchant.toUpperCase(),
  merchant_name: merchant, amount, account_id: 'a1', account_name: 'ANZ', category: cat,
  status: 'posted', type: 'PAYMENT', counts_to_budget: true,
});
const COLES = row('coles', 'Coles', -12.5);
const STEVEN_DEEP = row('steven-old', 'Steven Nguyen', -77, '2024-02-03');

const type = (query: string) => fireEvent.changeText(screen.getByPlaceholderText('Search transactions'), query);
const pauseTyping = () => act(() => { jest.advanceTimersByTime(300); });
const answered = (results: unknown[], over: Record<string, unknown> = {}) =>
  ({ ...idleSearch, active: true, answered: true, results, ...over });

beforeEach(() => {
  jest.useFakeTimers();
  mockHookCalls.length = 0;
  mockServerCount = undefined;
  mockTx = transactionsScreenData({ transactions: [COLES], category, hasMore: true });
});
afterEach(() => { jest.useRealTimers(); });

it('[A1] the previous query\'s answer never produces "No matches" for newer live text', () => {
  mockTx = transactionsScreenData({ transactions: [COLES], category, hasMore: true, search: answered([STEVEN_DEEP]) });
  render(<Transactions />);
  type('steven');
  pauseTyping();
  expect(screen.getByText('-$77.00')).toBeTruthy();

  type('stevenx'); // the hook still hands back the "steven" answer until typing pauses
  expect(screen.queryByTestId('transactions-no-results')).toBeNull();
  expect(screen.getByTestId('transactions-searching')).toBeTruthy();
});

it('[A2] clearing the box restores the feed immediately, before the debounce settles', () => {
  mockTx = transactionsScreenData({ transactions: [COLES], category, hasMore: true, search: answered([STEVEN_DEEP], { truncated: true }) });
  render(<Transactions />);
  type('steven');
  pauseTyping();
  expect(screen.queryByTestId('transactions-load-more')).toBeNull();

  fireEvent.press(screen.getByLabelText('Clear search'));
  expect(mockHookCalls.at(-1)).toEqual(['all', 'steven']); // debounced value not yet cleared
  expect(screen.getByText('-$12.50')).toBeTruthy();
  expect(screen.queryByText('-$77.00')).toBeNull();
  expect(screen.getByTestId('transactions-load-more')).toBeTruthy();
  expect(screen.queryByTestId('transactions-searching')).toBeNull();
  expect(screen.queryByTestId('transactions-search-truncated')).toBeNull();

  pauseTyping();
  expect(mockHookCalls.at(-1)).toEqual(['all', '']);
});

it('[A3] Uncategorized tab: a re-filed search result drops out, an unfiled one stays', () => {
  const filed = row('steven-filed', 'Steven Nguyen', -33, '2024-01-01', 'groceries');
  mockTx = transactionsScreenData({ transactions: [], category, hasMore: true, search: answered([STEVEN_DEEP, filed]) });
  render(<Transactions />);
  fireEvent.press(screen.getByTestId('tab-uncategorized'));
  type('steven');
  pauseTyping();
  expect(mockHookCalls.at(-1)).toEqual(['uncategorized', 'steven']);
  expect(screen.getByText('-$77.00')).toBeTruthy();
  expect(screen.queryByText('-$33.00')).toBeNull();
});

it('[A4] pull-to-refresh spins when only the search result has rows', () => {
  const refetchList = jest.fn(() => new Promise<void>(() => {})); // the pull stays in flight
  mockTx = transactionsScreenData({ transactions: [], category, refetchList, search: answered([STEVEN_DEEP]) });
  render(<Transactions />);
  type('steven');
  pauseTyping();
  act(() => { screen.UNSAFE_getByType(RefreshControl).props.onRefresh(); });
  expect(refetchList).toHaveBeenCalled();
  expect(screen.UNSAFE_getByType(RefreshControl).props.refreshing).toBe(true);
});

// The card's original bug as an invariant. A "$"-only query (the first key of "$42") never asks the
// server, so it must behave like an empty box — not claim "No matches" above Load More.
it('[A5] "$" on the Uncategorized tab never claims "No matches" while Load More is showing', () => {
  mockServerCount = 4; // unfiled charges exist deeper in history
  mockTx = transactionsScreenData({ transactions: [row('filed', 'Coles', -12.5, '2026-07-01', 'groceries')], category, hasMore: true });
  render(<Transactions />);
  fireEvent.press(screen.getByTestId('tab-uncategorized'));
  type('$');
  pauseTyping();
  expect(screen.queryByTestId('transactions-no-results')).toBeNull();
  expect(screen.getByTestId('transactions-uncategorized-more')).toBeTruthy();
  expect(screen.getByTestId('transactions-load-more')).toBeTruthy();
});
