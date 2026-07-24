// WHIT-330 — GAP (Transactions screen): the surfaces the row/logic tests don't render.
//   [A-empty] a TRANSFERS-ONLY account no longer shows "All caught up" on the Uncategorized tab —
//             the transfer row is listed and the badge is non-zero (was empty/caught-up pre-330).
//   [A-file]  the transfer is now reachable + bulk-fileable FROM the Uncategorized tab in
//             selection mode — the only escape hatch for its grey, non-tappable row on that tab.
// The existing whit328SelectGap covers the ALL tab only (and its comment that the transfer is
// "NOT on the Uncategorized tab" is stale under WHIT-330 — see critique).
import { it, expect, jest, beforeEach, describe } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';

let mockTx: ReturnType<typeof txData>;
jest.mock('../queries', () => ({ useTransactionsScreenData: () => mockTx }));

const mockOpenMultiPicker = jest.fn();
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ openPicker: jest.fn(), openMultiPicker: mockOpenMultiPicker }) };
});

jest.mock('expo-router', () => {
  const ReactLib = require('react');
  return { useFocusEffect: (cb: () => void) => ReactLib.useEffect(() => cb(), [cb]), useRouter: () => ({ push: jest.fn() }) };
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
  return { transactions: [], category, balances: new Map(), isLoading: false, isError: false, isFetching: false, refetch: jest.fn(), refetchStale: jest.fn(), ...over };
}
beforeEach(() => { mockOpenMultiPicker.mockClear(); mockTx = txData({ transactions: [transfer] }); });

// The segmented control label 'Uncategorized' AND the transfer row's category label are both
// 'Uncategorized'; the seg renders first in tree order, so index [0] is the tab button.
const pressUncategorizedTab = () => fireEvent.press(screen.getAllByText('Uncategorized')[0]);

describe('WHIT-330 [A-empty] — transfers-only account is NOT "All caught up"', () => {
  // Fail-on-revert: restore the countUncategorized gate → uncategorizedCount 0 → "All caught up"
  // renders again → the first assertion fails.
  it('lists the transfer on the Uncategorized tab and hides the caught-up empty state', () => {
    render(<Transactions />);
    pressUncategorizedTab();
    expect(screen.queryByText('All caught up')).toBeNull();
    // The transfer row is present (merchant label is unique, unlike 'Uncategorized').
    expect(screen.getByText('Internal Transfer')).toBeTruthy();
  });
});

describe('WHIT-330 [A-file] — the transfer is bulk-fileable from the Uncategorized tab', () => {
  // Fail-on-revert: restore the transactionGroups 'uncategorized' gate → the transfer is not
  // listed on this tab → getByLabelText('Select Internal Transfer') throws → this fails.
  it('selection mode on the Uncategorized tab can hand the transfer to the picker', () => {
    render(<Transactions />);
    pressUncategorizedTab();
    fireEvent.press(screen.getByText('Select'));
    fireEvent.press(screen.getByLabelText('Select Internal Transfer'));
    expect(screen.getByText('1 selected')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Re-categorize selected transactions'));
    expect(mockOpenMultiPicker).toHaveBeenCalledWith(['xfer1']);
  });
});
