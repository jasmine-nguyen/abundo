// WHIT-272 — the transaction detail screen (read-only slice). Reached by the row chevron;
// the id in the route is the transaction_id. The transaction comes from the SAME cached
// query the lists use (mocked here), found by id. Verifies the fields render, the pending
// label, the "not found" state for a stale id, and cache-first error handling. The next
// slice adds the editable note + tags.
import { it, expect, jest, beforeEach, describe } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { makeState, cat, txn } from './factory';

let mockTx: ReturnType<typeof txData>;
jest.mock('../queries', () => ({ useTransactionsScreenData: () => mockTx, useRecentTransactionsScreenData: () => ({ transactions: [] }) }));

// WHIT-275: the screen's note/tags editor reads applyTransactionEdit from the context; stub
// it (real selectors kept) so these read-path tests render without an AppProvider.
// WHIT-459: the context stub is the SUPERSET of the folded siblings' stubs — applyTransactionEdit
// (all four), showToast (from transactionDetailExcludedEdges), and openPicker (from
// transactionRecategorize). The extra members are inert for read-path tests: the ExcludedEdges and
// Recategorize files each rendered the screen with these present and stayed green.
const mockApplyTransactionEdit = jest.fn();
const mockToast = jest.fn();
const mockOpenPicker = jest.fn();
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return {
    ...actual,
    useAppContext: () => ({
      applyTransactionEdit: mockApplyTransactionEdit,
      showToast: mockToast,
      openPicker: mockOpenPicker,
    }),
  };
});

let mockId = 't1';
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: mockId }),
  useRouter: () => ({ back: jest.fn(), push: jest.fn() }),
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

import TransactionDetail from '../../app/transaction/[id]';

const category = makeState({ categories: [cat()] }).category; // cat() → id 'coffee', name 'Cafes & Coffee'

function txData(over: Partial<{ transactions: unknown[]; isLoading: boolean; isError: boolean; refetch: () => void }> = {}) {
  return {
    transactions: [txn({ transaction_id: 't1', category: 'coffee' })],
    category, balances: new Map(),
    isLoading: false, isError: false, isFetching: false,
    refetch: jest.fn(), refetchStale: jest.fn(),
    ...over,
  };
}

beforeEach(() => {
  mockId = 't1';
  mockTx = txData();
  mockApplyTransactionEdit.mockClear();
  mockToast.mockClear();
  mockOpenPicker.mockClear();
});

it('renders the transaction fields (merchant, amount, date, account, category, status)', () => {
  render(<TransactionDetail />);
  expect(screen.getByText('Woolworths')).toBeTruthy();
  expect(screen.getByText('-$12.50')).toBeTruthy();
  expect(screen.getByText('1 Jul 2026')).toBeTruthy();
  expect(screen.getByText('Everyday')).toBeTruthy();
  expect(screen.getByText('Cafes & Coffee')).toBeTruthy();
  expect(screen.getByText('Posted')).toBeTruthy();
});

it('shows Pending for a pending transaction', () => {
  mockTx = txData({ transactions: [txn({ transaction_id: 't1', category: 'coffee', status: 'pending' })] });
  render(<TransactionDetail />);
  expect(screen.getByText('Pending')).toBeTruthy();
});

it('shows a not-found state when no transaction carries the route id (stale link)', () => {
  mockId = 'ghost';
  render(<TransactionDetail />);
  expect(screen.getByText('Transaction not found')).toBeTruthy();
});

it('a hard read failure with nothing cached shows the inline error + an accessible Retry', () => {
  const refetch = jest.fn();
  mockTx = txData({ transactions: [], isError: true, refetch });
  render(<TransactionDetail />);

  expect(screen.getByTestId('transaction-error')).toBeTruthy();
  const retry = screen.getByTestId('transaction-retry');
  expect(retry.props.accessibilityRole).toBe('button');
  expect(retry.props.accessibilityLabel).toBe('Retry loading this transaction');

  fireEvent.press(retry);
  expect(refetch).toHaveBeenCalledTimes(1);
});

it('does NOT show the error when a background refetch fails over cached rows (cache-first)', () => {
  mockTx = txData({ isError: true }); // errored, but the row is cached
  render(<TransactionDetail />);
  expect(screen.queryByTestId('transaction-error')).toBeNull();
  expect(screen.getByText('Woolworths')).toBeTruthy();
});

// [A-loading-gate] (adversarial gap) Genuinely loading with an EMPTY cache: showSpinner is true, so
// the "not found" branch (which also matches when transaction is undefined) MUST stay hidden.
// A revert that drops the `!showSpinner` guard on the empty state would flash "not found" under
// every cold load — this test fails if that happens.
it('while loading with nothing cached, shows the spinner and NOT the not-found state', () => {
  mockTx = txData({ transactions: [], isLoading: true });
  render(<TransactionDetail />);
  expect(screen.getByTestId('transaction-loading')).toBeTruthy();
  expect(screen.queryByText('Transaction not found')).toBeNull();
});

// ===== WHIT-298 (folded from transactionDetailExcludedEdges.screen.test.tsx)
// Original mocked ../queries + ../context + expo-router + react-native-safe-area-context with the
// same factory bodies as this survivor, except its context stub added showToast (now in the shared
// superset above) and hardcoded the route id 't1' (equivalent to the module-level mockId reset).

// [A-detail-combo] the bank flag wins: even with the user's budget_excluded also set, the screen
// shows the read-only note and hides the (would-be inert) manual toggle.
it('shows the read-only note and NO toggle when bank-excluded AND user-excluded', () => {
  mockTx = txData({ transactions: [txn({ transaction_id: 't1', category: 'coffee', counts_to_budget: false, budget_excluded: true })] });
  render(<TransactionDetail />);
  expect(screen.getByText('Excluded (transfer)')).toBeTruthy();
  expect(screen.queryByRole('switch', { name: 'Exclude from budgets' })).toBeNull();
});

// [A-detail-undef] CONSISTENCY: when the server omits counts_to_budget, the detail screen shows
// the read-only "Excluded (transfer)" note and hides the toggle (it gates on the falsy
// counts_to_budget test), rather than a contradictory OFF switch. Fails if the gate reverts to a
// strict `=== false` (which would fall through to the toggle for undefined). (The list row's
// "Not in budget" tag was removed in WHIT-330, so this is now purely a detail-screen guard.)
it('shows the read-only note (not the toggle) when counts_to_budget is undefined — matching the list tag', () => {
  mockTx = txData({ transactions: [txn({ transaction_id: 't1', category: 'coffee', counts_to_budget: undefined })] });
  render(<TransactionDetail />);
  expect(screen.getByText('Excluded (transfer)')).toBeTruthy();
  expect(screen.queryByRole('switch', { name: 'Exclude from budgets' })).toBeNull();
});

// ===== WHIT-276 (folded from transactionDetailStates.screen.test.tsx)
// Original mocked ../queries + ../context + expo-router + react-native-safe-area-context with
// factory bodies byte-identical to this survivor's; reuses the shared mockId/mockTx/txData/category.

// [A-txn-both] Empty cache, isLoading && isError both true: through the real screen both the
// spinner and the error render stacked and the "not found" empty message stays hidden. A
// collapse to either/or, or dropping the hasCache gate, breaks this.
it('with an empty cache, isLoading && isError renders BOTH the spinner and the error, not the not-found state', () => {
  mockTx = txData({ transactions: [], isLoading: true, isError: true });
  render(<TransactionDetail />);
  expect(screen.getByTestId('transaction-loading')).toBeTruthy();
  expect(screen.getByTestId('transaction-error')).toBeTruthy();
  expect(screen.queryByText('Transaction not found')).toBeNull();
});

// ===== WHIT-287 (folded from transactionRecategorize.screen.test.tsx)
// Original mocked ../queries + ../context + expo-router + react-native-safe-area-context. Its
// context stub added openPicker (now in the shared superset above, cleared per-test in beforeEach);
// factory bodies otherwise byte-identical to this survivor's.

it('tapping the Category row opens the picker for this transaction', () => {
  render(<TransactionDetail />);
  // The row is a button labelled with the current category so it reads as "tap to change".
  const row = screen.getByLabelText('Change category, currently Cafes & Coffee');
  expect(row.props.accessibilityRole).toBe('button');

  fireEvent.press(row);
  expect(mockOpenPicker).toHaveBeenCalledTimes(1);
  expect(mockOpenPicker).toHaveBeenCalledWith('t1');
});

// The top-level test above already covers the already-categorized (coffee) case; these cover
// the states a LIST row would NOT make tappable — proving the detail row re-files regardless.
describe('re-categorize is offered regardless of the current category', () => {
  it('an income-tagged transaction is re-filable', () => {
    mockTx = txData({ transactions: [txn({ transaction_id: 't1', category: 'income', amount: 2500 })] });
    render(<TransactionDetail />);
    fireEvent.press(screen.getByLabelText('Change category, currently Income'));
    expect(mockOpenPicker).toHaveBeenCalledWith('t1');
  });

  it('an uncategorized transaction is re-filable', () => {
    mockTx = txData({ transactions: [txn({ transaction_id: 't1', category: null })] });
    render(<TransactionDetail />);
    fireEvent.press(screen.getByLabelText('Change category, currently Uncategorized'));
    expect(mockOpenPicker).toHaveBeenCalledWith('t1');
  });

  it('a pending transaction is re-filable', () => {
    mockTx = txData({ transactions: [txn({ transaction_id: 't1', category: 'coffee', status: 'pending' })] });
    render(<TransactionDetail />);
    fireEvent.press(screen.getByLabelText('Change category, currently Cafes & Coffee'));
    expect(mockOpenPicker).toHaveBeenCalledWith('t1');
  });
});

it('the picker targets the routed transaction id (not a hardcoded one)', () => {
  mockId = 't2';
  mockTx = txData({ transactions: [txn({ transaction_id: 't2', category: 'coffee' })] });
  render(<TransactionDetail />);
  fireEvent.press(screen.getByLabelText('Change category, currently Cafes & Coffee'));
  expect(mockOpenPicker).toHaveBeenCalledWith('t2');
});
