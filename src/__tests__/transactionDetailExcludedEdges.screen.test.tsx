// WHIT-298 — adversarial GAP tests for the detail screen's read-only note vs manual toggle.
// The implementer's transactionEdit.screen.test.tsx covers bank-false (note, no toggle) and
// normal (toggle, no note). These add: (1) bank+user exclusion together (bank note WINS over the
// user toggle), and (2) the counts_to_budget-undefined DIVERGENCE — the list tags the row
// "Not in budget", yet the detail still shows the editable toggle (strict === false). This test
// pins the CURRENT behaviour; see the ranked critique for why it's a bug.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { makeState, cat, txn } from './factory';

const mockEdit = jest.fn();
const mockToast = jest.fn();
let mockTx: ReturnType<typeof txData>;
jest.mock('../queries', () => ({ useTransactionsScreenData: () => mockTx }));
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ applyTransactionEdit: mockEdit, showToast: mockToast }) };
});
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: 't1' }),
  useRouter: () => ({ back: jest.fn(), push: jest.fn() }),
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

import TransactionDetail from '../../app/transaction/[id]';

const category = makeState({ categories: [cat()] }).category;
function txData(over: Partial<{ transactions: unknown[] }> = {}) {
  return {
    transactions: [txn({ transaction_id: 't1', category: 'coffee' })],
    category, balances: new Map(),
    isLoading: false, isError: false, isFetching: false,
    refetch: jest.fn(), refetchStale: jest.fn(),
    ...over,
  };
}
beforeEach(() => { mockEdit.mockClear(); mockToast.mockClear(); mockTx = txData(); });

// [A-detail-combo] the bank flag wins: even with the user's budget_excluded also set, the screen
// shows the read-only note and hides the (would-be inert) manual toggle.
it('shows the read-only note and NO toggle when bank-excluded AND user-excluded', () => {
  mockTx = txData({ transactions: [txn({ transaction_id: 't1', category: 'coffee', counts_to_budget: false, budget_excluded: true })] });
  render(<TransactionDetail />);
  expect(screen.getByText('Excluded (transfer)')).toBeTruthy();
  expect(screen.queryByRole('switch', { name: 'Exclude from budgets' })).toBeNull();
});

// [A-detail-undef] CONSISTENCY (WHIT-298 F1 fix): when the server omits counts_to_budget, the
// list row is tagged "Not in budget" (transactionView.excluded === true). The detail screen
// gates on the same falsy-counts_to_budget test, so it agrees — it shows the read-only note and
// hides the toggle, rather than a contradictory OFF switch. Fails if the gate reverts to a strict
// `=== false` (which would fall through to the toggle for undefined).
it('shows the read-only note (not the toggle) when counts_to_budget is undefined — matching the list tag', () => {
  mockTx = txData({ transactions: [txn({ transaction_id: 't1', category: 'coffee', counts_to_budget: undefined })] });
  render(<TransactionDetail />);
  expect(screen.getByText('Excluded (transfer)')).toBeTruthy();
  expect(screen.queryByRole('switch', { name: 'Exclude from budgets' })).toBeNull();
});
