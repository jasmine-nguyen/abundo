// WHIT-328 — GAP: the single-tap "not tappable" gate only blocks the LIST tap. In SELECTION mode
// on the All tab, a not-in-budget uncategorized charge is still selectable and can be handed to
// the bulk picker (openMultiPicker). This pins that reachable path — see the ranked critique for
// whether it's acceptable (the user explicitly opts into selection mode) vs a real leak.
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

// A not-in-budget uncategorized transfer: null category, counts_to_budget false.
const transfer = {
  transaction_id: 'xfer1', date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'INTERNAL TRANSFER', merchant_name: 'Internal Transfer', amount: -500, account_id: 'a1',
  account_name: 'ANZ', category: null, status: 'posted', type: 'transfer', counts_to_budget: false,
};
const category = (_id: string | null) => undefined;

function txData(over: Partial<{ transactions: unknown[] }> = {}) {
  return { transactions: [], category, isLoading: false, isError: false, isFetching: false, refetch: jest.fn(), refetchStale: jest.fn(), ...over };
}
beforeEach(() => { mockOpenMultiPicker.mockClear(); mockTx = txData({ transactions: [transfer] }); });

it('a not-in-budget uncategorized transfer is still bulk-selectable on the All tab and handed to the picker', () => {
  render(<Transactions />);
  // It is NOT on the Uncategorized tab (badge gated on contributesToBudget) — start on All.
  fireEvent.press(screen.getByText('Select'));
  fireEvent.press(screen.getByLabelText('Select Internal Transfer'));
  expect(screen.getByText('1 selected')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('Re-categorize selected transactions'));
  expect(mockOpenMultiPicker).toHaveBeenCalledWith(['xfer1']);
});
