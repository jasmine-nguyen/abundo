// WHIT-291 — the Transactions selection mode. A "Select" button swaps the rows for checkboxes;
// toggling rows tracks a set; the action bar's "Re-categorize" hands those ids to the picker
// (openMultiPicker) and leaves selection mode; "Cancel" exits. The batch write + sheet are tested
// elsewhere — this covers the screen's selection state + wiring.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';

let mockTx: ReturnType<typeof txData>;
jest.mock('../queries', () => ({ useTransactionsScreenData: () => mockTx }));

const mockOpenMultiPicker = jest.fn();
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ openPicker: () => {}, openMultiPicker: mockOpenMultiPicker }) };
});

jest.mock('expo-router', () => {
  const React = require('react');
  return { useFocusEffect: (cb: () => void) => React.useEffect(() => cb(), [cb]), useRouter: () => ({ push: jest.fn() }) };
});

import Transactions from '../../app/(tabs)/transactions';

const CAT = { id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#7FD49B', recent: 0 };
const row = (id: string, merchant: string) => ({
  transaction_id: id, date: '2026-07-01', authorized_date: '2026-07-01',
  description: merchant.toUpperCase(), merchant_name: merchant, amount: -42, account_id: 'a1',
  account_name: 'ANZ', category: 'groceries', status: 'posted', type: 'purchase', counts_to_budget: true,
});
const category = (id: string | null) => (id === 'groceries' ? CAT : undefined);

function txData(over: Partial<{ transactions: unknown[] }> = {}) {
  return { transactions: [], category, isLoading: false, isError: false, isFetching: false, refetch: jest.fn(), refetchStale: jest.fn(), ...over };
}

beforeEach(() => {
  mockOpenMultiPicker.mockClear();
  mockTx = txData({ transactions: [row('t1', 'Woolworths'), row('t2', 'Coles')] });
});

it('there is no selection UI until "Select" is tapped', () => {
  render(<Transactions />);
  expect(screen.getByText('Select')).toBeTruthy();
  expect(screen.queryByLabelText('Select Woolworths')).toBeNull(); // no checkboxes yet
});

it('Select enters selection mode; toggling rows updates the count; Re-categorize hands the ids to the picker', () => {
  render(<Transactions />);
  fireEvent.press(screen.getByText('Select'));

  // Even a categorized row (Woolworths → groceries) is selectable in this mode.
  fireEvent.press(screen.getByLabelText('Select Woolworths'));
  fireEvent.press(screen.getByLabelText('Select Coles'));
  expect(screen.getByText('2 selected')).toBeTruthy();

  fireEvent.press(screen.getByLabelText('Select Coles')); // untoggle one
  expect(screen.getByText('1 selected')).toBeTruthy();

  fireEvent.press(screen.getByLabelText('Re-categorize selected transactions'));
  expect(mockOpenMultiPicker).toHaveBeenCalledWith(['t1']);
});

it('Re-categorize does nothing with an empty selection (disabled)', () => {
  render(<Transactions />);
  fireEvent.press(screen.getByText('Select'));
  fireEvent.press(screen.getByLabelText('Re-categorize selected transactions'));
  expect(mockOpenMultiPicker).not.toHaveBeenCalled();
});

it('Cancel leaves selection mode and clears the checkboxes', () => {
  render(<Transactions />);
  fireEvent.press(screen.getByText('Select'));
  expect(screen.getByLabelText('Select Woolworths')).toBeTruthy();

  fireEvent.press(screen.getByText('Cancel'));
  expect(screen.queryByLabelText('Select Woolworths')).toBeNull();
  expect(screen.getByText('Select')).toBeTruthy();
});
