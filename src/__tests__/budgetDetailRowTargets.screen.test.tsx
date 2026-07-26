// budget cafe-mismatch — GAP tests for the budget-detail Related Transactions rows after the swap
// to the shared TransactionRow. The implementer's budgetDetailRefile covers arrow-per-row,
// arrow→/transaction/<id>, and pending-badge-kept; TransactionRow.screen.test covers the row in
// isolation. These lock the BUDGET-SCREEN INTEGRATION gaps: mixed pending/posted badge count, the
// two press-targets on an uncategorized related row, and a categorized row staying body-inert
// (proving the screen wires the real category lookup, not an empty one).
// ../queries re-routed via the shared screenQueryMocks harness; ../context real except a STABLE
// openPicker so the picker path can be asserted; expo-router stubbed to capture push.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import type { ScreenState } from './support/screenQueryMocks';

let mockState: ScreenState;
jest.mock('../queries', () => require('./support/screenQueryMocks').queryMocksFromState(() => mockState));

const mockOpenPicker = jest.fn();
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ deleteBudget: jest.fn(), openPicker: mockOpenPicker }) };
});

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn() }),
  useLocalSearchParams: () => ({ id: 'coffee' }),
}));

import BudgetDetail from '../../app/budget/[id]';

const CATS = [{ id: 'coffee', name: 'Cafes & Coffee', bucket: 'Lifestyle', icon: 'coffee', color: '#E8A87C', recent: 0 }];
const BUDGETS = [{ id: 'coffee', budget: 80, posted: 15, pending: 5 }];

function charge(over: Record<string, unknown>) {
  return {
    transaction_id: 't1', date: '2026-07-20', authorized_date: '2026-07-20',
    description: 'CAFE', merchant_name: 'Cafe', amount: -5,
    account_id: 'a1', account_name: 'Everyday', category: 'coffee',
    status: 'posted', type: 'purchase', counts_to_budget: true, ...over,
  };
}

beforeEach(() => {
  mockOpenPicker.mockClear();
  mockPush.mockClear();
  mockState = { categories: CATS, budgets: BUDGETS, transactions: [charge({})], cycleLen: 30, daysLeft: 5, payCycleError: false };
});

// [G1] mixed pending + posted → the Pending badge is per-row (exactly one, on the pending row),
// and the old row's always-on "Posted" status text did NOT come along with the swap.
it('shows the Pending badge on exactly the pending row in a mixed list (no stray Posted text)', () => {
  mockState = { ...mockState, transactions: [
    charge({ transaction_id: 't1', status: 'pending' }),
    charge({ transaction_id: 't2', status: 'posted' }),
    charge({ transaction_id: 't3', status: 'posted' }),
  ] };
  render(<BudgetDetail />);

  expect(screen.getAllByText('Pending')).toHaveLength(1);                       // only the pending row
  expect(screen.queryByText('Posted')).toBeNull();                             // old status text is gone
});

// [G2] locks the shared row's dual-target contract as this screen wires it. In prod a budget's
// related list is filtered to its category subtree and only uncategorized rows are body-tappable,
// so no real budget row is ever body-tappable — this feeds an uncategorized row anyway to prove the
// wiring seam (real openPicker via context + real router): the body opens the picker for THIS id
// AND the trailing arrow still routes to the detail page, with neither cannibalising the other.
it('an uncategorized related row exposes both a body refile-tap and a details arrow', () => {
  mockState = { ...mockState, transactions: [charge({ transaction_id: 'tx9', category: null })] };
  render(<BudgetDetail />);

  // Body: pressing the Uncategorized label opens the picker for THIS transaction.
  fireEvent.press(screen.getByText('Uncategorized'));
  expect(mockOpenPicker).toHaveBeenCalledWith('tx9');

  // Arrow: still present and routes to the detail page, without a second picker call.
  fireEvent.press(screen.getByLabelText('View transaction details'));
  expect(mockPush).toHaveBeenCalledWith('/transaction/tx9');
  expect(mockOpenPicker).toHaveBeenCalledTimes(1);
});

// [G3] a CATEGORIZED related row shows its category name (proving the screen passed the real
// category lookup, not an empty one that would make every row read "Uncategorized") and its body
// is INERT — the only refile route is arrow → detail → Change category, matching the "done" def.
it('a categorized related row is body-inert and refiles only via the arrow', () => {
  mockState = { ...mockState, transactions: [charge({ transaction_id: 't1', category: 'coffee' })] };
  render(<BudgetDetail />);

  // Assert "Uncategorized" is absent anywhere: an empty category lookup would make the row read
  // "Uncategorized", so its absence proves the screen passed the real taxonomy. (The header shows the
  // category name "Cafes & Coffee", not "Uncategorized", so a global absence check is safe here.)
  expect(screen.queryByText('Uncategorized')).toBeNull();
  fireEvent.press(screen.getByText('Cafe'));                   // press the row body (unique merchant)
  expect(mockOpenPicker).not.toHaveBeenCalled();               // body tap does nothing on a filed row

  fireEvent.press(screen.getByLabelText('View transaction details'));
  expect(mockPush).toHaveBeenCalledWith('/transaction/t1');    // arrow is the sole refile entry
});
