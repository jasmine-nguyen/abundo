// The Transactions-tab search box (previously a dead placeholder): typing filters the list
// live, the ✕ clears it, no matches shows an empty state, and entering selection mode clears
// the search (the box hides there, so the list must not stay secretly filtered). The composite
// (../queries) is mocked; ../context is partially mocked (real selectors, stubbed useAppContext
// for TransactionRow); expo-router is stubbed.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';

const CATS: Record<string, { id: string; name: string; bucket: string; icon: string; color: string; recent: number }> = {
  groceries: { id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#7FD49B', recent: 0 },
  coffee: { id: 'coffee', name: 'Cafes & Coffee', bucket: 'Lifestyle', icon: 'coffee', color: '#E8A87C', recent: 0 },
};
const category = (id: string | null) => (id ? CATS[id] : undefined);

let mockTx: ReturnType<typeof txData>;
jest.mock('../queries', () => ({ useTransactionsScreenData: () => mockTx }));

jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ openPicker: jest.fn(), openMultiPicker: jest.fn(), category }) };
});

jest.mock('expo-router', () => {
  const ReactLib = require('react');
  return { useFocusEffect: (cb: () => void) => ReactLib.useEffect(() => cb(), [cb]), useRouter: () => ({ push: jest.fn() }) };
});

import Transactions from '../../app/(tabs)/transactions';

const row = (over: Record<string, unknown>) => ({
  transaction_id: 't', date: '2026-07-01', authorized_date: '2026-07-01', description: '', merchant_name: '',
  amount: -10, account_id: 'a1', account_name: 'ANZ', category: 'groceries', status: 'posted', type: 'purchase',
  counts_to_budget: true, ...over,
});

const WOOLIES = row({ transaction_id: 'w', merchant_name: 'Woolworths', description: 'WOOLWORTHS', category: 'groceries', amount: -42 });
const COFFEE = row({ transaction_id: 'c', merchant_name: 'ST Ali', description: 'ST ALI', category: 'coffee', amount: -8.5 });

function txData(over: Partial<{ transactions: unknown[]; isLoading: boolean; isError: boolean }> = {}) {
  return {
    transactions: [WOOLIES, COFFEE], category, balances: new Map(),
    isLoading: false, isError: false, isFetching: false, refetch: jest.fn(), refetchStale: jest.fn(), ...over,
  };
}

beforeEach(() => { mockTx = txData(); });

const type = (q: string) => fireEvent.changeText(screen.getByPlaceholderText('Search transactions'), q);

it('typing filters the list to matching rows', () => {
  render(<Transactions />);
  expect(screen.getByText('-$42.00')).toBeTruthy();
  expect(screen.getByText('-$8.50')).toBeTruthy();

  type('wool');
  expect(screen.getByText('-$42.00')).toBeTruthy();   // Woolworths matches
  expect(screen.queryByText('-$8.50')).toBeNull();    // coffee filtered out
});

it('matches by category name, not just merchant', () => {
  render(<Transactions />);
  type('cafes');                                       // the coffee row's category is "Cafes & Coffee"
  expect(screen.getByText('-$8.50')).toBeTruthy();
  expect(screen.queryByText('-$42.00')).toBeNull();
});

it('matches by amount', () => {
  render(<Transactions />);
  type('8.50');
  expect(screen.getByText('-$8.50')).toBeTruthy();
  expect(screen.queryByText('-$42.00')).toBeNull();
});

it('the ✕ clears the search and restores the full list', () => {
  render(<Transactions />);
  type('wool');
  expect(screen.queryByText('-$8.50')).toBeNull();

  fireEvent.press(screen.getByLabelText('Clear search'));
  expect(screen.getByText('-$42.00')).toBeTruthy();
  expect(screen.getByText('-$8.50')).toBeTruthy();
});

it('a query with no matches shows the empty state and no rows', () => {
  render(<Transactions />);
  type('zzzzz');
  expect(screen.getByTestId('transactions-no-results')).toBeTruthy();
  expect(screen.queryByText('-$42.00')).toBeNull();
  expect(screen.queryByText('-$8.50')).toBeNull();
});

it('entering selection mode clears an active search (the box hides, so no secret filter)', () => {
  render(<Transactions />);
  type('wool');
  expect(screen.queryByText('-$8.50')).toBeNull();

  fireEvent.press(screen.getByText('Select'));
  // The search box is gone in selection mode, and the list is back to the full set. In selection
  // mode the row body is a11y-hidden (the checkbox owns the label), so assert on the checkboxes.
  expect(screen.queryByPlaceholderText('Search transactions')).toBeNull();
  expect(screen.getByLabelText('Select Woolworths')).toBeTruthy();
  expect(screen.getByLabelText('Select ST Ali')).toBeTruthy();
});
