// WHIT-495 — GAP (plan-noted edge): the header gear stays in the Transactions header while the
// screen is in multi-select mode (the `left` prop is unconditional). Tapping it must push
// /settings WITHOUT tearing down the in-progress selection, so returning lands the user back in
// selection with their picks intact. settingsGear covers the gear in the DEFAULT state only.
// Fail-on-revert: gate `left={!selectionMode && <SettingsButton/>}` (hide the gear while
// selecting) → getByLabelText('Settings') throws → this goes RED.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';

const mockPush = jest.fn();
let mockTx: ReturnType<typeof txData>;
jest.mock('../queries', () => ({
  useTransactionsScreenData: () => mockTx,
  // WHIT-501: the screen now reads the server tally for the count. Mirror the LOCAL count here so
  // the badge and "All caught up" gating stay driven by these fixtures exactly as before.
  useUncategorizedCount: () => (jest.requireActual('../context') as typeof import('../context')).countUncategorized(mockTx as any),
}));

const mockOpenMultiPicker = jest.fn();
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ openPicker: () => {}, openMultiPicker: mockOpenMultiPicker }) };
});

jest.mock('expo-router', () => {
  const React = require('react');
  return { useFocusEffect: (cb: () => void) => React.useEffect(() => cb(), [cb]), useRouter: () => ({ push: mockPush }) };
});

import Transactions from '../../app/(tabs)/transactions';

const charge = {
  transaction_id: 'c1', date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'COFFEE', merchant_name: 'Cafe', amount: -5, account_id: 'a1',
  account_name: 'ANZ', category: null, status: 'posted', type: 'purchase', counts_to_budget: true,
};
const category = (_id: string | null) => undefined;

function txData(over: Partial<{ transactions: unknown[] }> = {}) {
  return { transactions: [], category, isLoading: false, isError: false, isFetching: false, refetch: jest.fn(), refetchStale: jest.fn(), ...over };
}
beforeEach(() => { mockPush.mockClear(); mockOpenMultiPicker.mockClear(); mockTx = txData({ transactions: [charge] }); });

it('keeps the gear reachable in selection mode: tapping it pushes /settings and leaves the selection intact', () => {
  render(<Transactions />);
  fireEvent.press(screen.getByText('Select'));
  fireEvent.press(screen.getByLabelText('Select Cafe'));
  expect(screen.getByText('1 selected')).toBeTruthy();

  // The gear coexists with the selection UI and taps without tearing it down.
  fireEvent.press(screen.getByLabelText('Settings'));
  expect(mockPush).toHaveBeenCalledWith('/settings');
  // Selection survives the navigation away (component is not unmounted on a root push).
  expect(screen.getByText('1 selected')).toBeTruthy();
  expect(screen.getByLabelText('Re-categorize selected transactions')).toBeTruthy();
});
