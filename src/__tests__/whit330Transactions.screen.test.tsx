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
import { makeState, cat, txn } from './factory';

let mockTx: ReturnType<typeof txData>;
// WHIT-459 fold: superset of both sources' ../queries factory — the list screen reads
// useTransactionsScreenData; the folded WHIT-328 detail test also imports (but does not
// depend on) useRecentTransactionsScreenData, so it's exported here harmlessly.
jest.mock('../queries', () => ({ useTransactionsScreenData: () => mockTx, useRecentTransactionsScreenData: () => ({ transactions: [] }) }));

// WHIT-459 fold: superset useAppContext serving both regimes. The list screen asserts on
// openMultiPicker; the folded detail test asserts on openPicker and needs applyTransactionEdit
// + showToast present. Every key below is harmless to the screen that doesn't use it.
const mockOpenPicker = jest.fn();
const mockOpenMultiPicker = jest.fn();
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ openPicker: mockOpenPicker, openMultiPicker: mockOpenMultiPicker, applyTransactionEdit: jest.fn(), showToast: jest.fn() }) };
});

// WHIT-459 fold: superset expo-router — useFocusEffect (list screen) + useLocalSearchParams
// (detail screen deep-link to id 't1') + useRouter with back+push (union). Each screen ignores
// the hooks it doesn't call.
jest.mock('expo-router', () => {
  const ReactLib = require('react');
  return {
    useFocusEffect: (cb: () => void) => ReactLib.useEffect(() => cb(), [cb]),
    useLocalSearchParams: () => ({ id: 't1' }),
    useRouter: () => ({ back: jest.fn(), push: jest.fn() }),
  };
});
// WHIT-459 fold: added from whit328Gaps for the folded detail screen (verbatim). Harmless to
// the list screen, which renders fine with zeroed insets.
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

import Transactions from '../../app/(tabs)/transactions';
import TransactionDetail from '../../app/transaction/[id]';

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

// ===== WHIT-328 (folded from whit328Gaps.screen.test.tsx) =====
// The DETAIL screen (a surface OTHER than the list row). WHIT-287 lets ANY charge be re-filed
// from the detail screen, so the single-tap list gate does NOT apply here. Module mocks above
// were reconciled to supersets serving both screens; this block re-seeds the shared mockTx via
// its own txData (block-scoped, shadowing the list screen's) and clears mockOpenPicker.
describe('WHIT-328 — detail screen re-file for an uncategorized charge', () => {
  const category = makeState({ categories: [cat()] }).category;
  function txData(over: Partial<{ transactions: unknown[] }> = {}) {
    return {
      transactions: [txn({ transaction_id: 't1', category: null, counts_to_budget: false })],
      category, balances: new Map(),
      isLoading: false, isError: false, isFetching: false,
      refetch: jest.fn(), refetchStale: jest.fn(),
      ...over,
    };
  }
  // The shared module `mockTx` is typed off the list screen's txData (whose `category` stub returns
  // undefined); this block's txData uses the real `makeState(...).category` (Category | undefined).
  // The shapes are otherwise identical and the detail tx has category:null (→ undefined either way),
  // so cast at the assignment boundary rather than widen the module type.
  beforeEach(() => { mockOpenPicker.mockClear(); mockTx = txData() as typeof mockTx; });

  // [A-detail] The detail screen for a not-in-budget uncategorized charge still labels the Category
  // field "Uncategorized" and keeps it tappable — the re-file picker still opens. (Contrast the list
  // row, which is now quiet + non-tappable.) Documents the intentional divergence; see critique.
  it('detail screen labels the Category "Uncategorized" and re-opens the picker on tap', () => {
    render(<TransactionDetail />);
    expect(screen.getByText('Uncategorized')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Change category, currently Uncategorized'));
    expect(mockOpenPicker).toHaveBeenCalledWith('t1');
  });
});
