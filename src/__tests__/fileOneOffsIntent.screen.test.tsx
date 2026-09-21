// WHIT-544 — the Transactions screen consumes the "File one-offs" intent set by the File-by-shop
// sheet: when `pendingUncategorizedSelect` is true it lands on the Uncategorized tab in selection
// mode, then CLEARS the flag so a later normal visit is not stuck selecting. The sheet-side button
// is covered in fileByShopSheetGaps ([A28d]/[A28e]); this file covers the screen-side consume.
import { it, expect, jest, beforeEach, describe } from '@jest/globals';
import React from 'react';
import { render, screen } from '@testing-library/react-native';

let mockTx: Record<string, unknown>;
let mockServerCount: number | undefined;
let mockMerchants: unknown;
jest.mock('../queries', () => ({
  useTransactionsScreenData: () => mockTx,
  useUncategorizedCount: () => mockServerCount,
  useUncategorizedMerchants: () => ({ merchants: mockMerchants, isLoading: false, isError: false }),
}));

// A STATEFUL flag so the one-shot lifecycle is real: the consume effect calls clearUncategorizedSelect,
// which flips the module flag false, exactly as the real provider would. mockClearSpy asserts it fired.
// (Names are `mock`-prefixed so jest.mock's factory may close over them.)
let mockPendingFlag = false;
const mockClearSpy = jest.fn(() => { mockPendingFlag = false; });
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return {
    ...actual,
    useAppContext: () => ({
      openMultiPicker: jest.fn(), showToast: jest.fn(), openPicker: jest.fn(), setSheet: jest.fn(),
      pendingUncategorizedSelect: mockPendingFlag, clearUncategorizedSelect: mockClearSpy,
    }),
  };
});
jest.mock('expo-router', () => {
  const ReactLib = require('react');
  return { useFocusEffect: (cb: () => void) => ReactLib.useEffect(() => cb(), [cb]), useRouter: () => ({ push: jest.fn() }) };
});

import Transactions from '../../app/(tabs)/transactions';

const CAT = { id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#7FD49B', recent: 0 };
const category = (id: string | null) => (id === 'groceries' ? CAT : undefined);
const unfiled = (id: string) => ({
  transaction_id: id, date: '2026-07-01', authorized_date: '2026-07-01', description: 'COLES',
  merchant_name: 'Coles', amount: -12.5, account_id: 'a1', account_name: 'ANZ', category: null,
  status: 'posted', type: 'PAYMENT', counts_to_budget: true,
});

function txData(over: Record<string, unknown> = {}) {
  return {
    transactions: [unfiled('t1')], category, balances: new Map(),
    isLoading: false, isError: false, isFetching: false, refetch: jest.fn(), refetchStale: jest.fn(),
    refetchList: jest.fn(() => Promise.resolve()), refreshLiveBalances: jest.fn(() => Promise.resolve()),
    hasMore: false, loadMore: jest.fn(), isLoadingMore: false, ...over,
  };
}

beforeEach(() => {
  mockTx = txData();
  mockServerCount = 3;
  mockMerchants = { unfiled: 3, groups: [], ungrouped: { count: 3, samples: ['ONE OFF'] } };
  mockPendingFlag = false;
  mockClearSpy.mockClear();
});

describe('WHIT-544 Transactions consumes the File-one-offs intent', () => {
  // [I1] flag set → the screen enters selection mode (Cancel header + "0 selected" bar) AND clears
  // the flag. Selection mode is the marker that we landed on the Uncategorized tab ready to pick.
  // Fail-on-revert: drop the consume effect and the screen stays on "Select" (no Cancel), no clear.
  it('[I1] lands in selection mode and clears the flag when the intent is set', () => {
    mockPendingFlag = true;
    render(<Transactions />);
    expect(screen.getByText('Cancel')).toBeTruthy();      // selection-mode header (not "Select")
    expect(screen.getByText('0 selected')).toBeTruthy();   // the selection action bar is up
    expect(mockClearSpy).toHaveBeenCalledTimes(1);             // one-shot: consumed and cleared
  });

  // [I2] flag NOT set → normal screen: the "Select" button shows, no selection bar. Guards that the
  // effect doesn't arm selection on every mount.
  it('[I2] a normal visit (flag false) is NOT in selection mode', () => {
    mockPendingFlag = false;
    render(<Transactions />);
    expect(screen.getByText('Select')).toBeTruthy();
    expect(screen.queryByText('0 selected')).toBeNull();
  });

  // [I3] one-shot proof across a remount: consuming CLEARS the flag, so a fresh mount of the screen
  // does NOT re-enter selection. Fail-on-revert: remove clearUncategorizedSelect() from the effect →
  // the stateful flag stays true → the remount re-arms selection and "Select" is not found.
  it('[I3] clears the flag so a remount does not re-arm selection', () => {
    mockPendingFlag = true;
    const first = render(<Transactions />);
    expect(screen.getByText('Cancel')).toBeTruthy();       // consumed → selection on
    expect(mockClearSpy).toHaveBeenCalledTimes(1);
    first.unmount();

    render(<Transactions />);                              // fresh mount; flag was cleared
    expect(screen.getByText('Select')).toBeTruthy();       // NOT re-armed
    expect(screen.queryByText('0 selected')).toBeNull();
  });
});
