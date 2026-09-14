// WHIT-272 — the transaction detail screen (read-only slice). Reached by the row chevron;
// the id in the route is the transaction_id. The transaction comes from the SAME cached
// query the lists use (mocked here), found by id. Verifies the fields render, the pending
// label, the "not found" state for a stale id, and cache-first error handling. The next
// slice adds the editable note + tags.
import { it, expect, jest, beforeEach, describe } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { makeState, cat, txn, budget } from './factory';
import type { Budget, Rule } from '../context';

// WHIT-539: a client Rule fixture (isNew is required on the interface). Defaults to a
// description/contains rule filing into 'coffee', the fixture transaction's category.
function rule(over: Partial<Rule> = {}): Rule {
  return { id: 'r1', pattern: 'COLES', categoryId: 'coffee', isNew: false, field: 'description', operator: 'contains', ...over };
}

let mockTx: ReturnType<typeof txData>;
let mockBudgets: Budget[] = [];
// WHIT-539: the rule-attribution line reads the rules cache from here. Default is loaded + empty,
// so the existing tests (no filed_by_rule) render no line; the rule tests set rules/isLoading.
let mockRules: { rules: Rule[]; isLoading: boolean } = { rules: [], isLoading: false };
jest.mock('../queries', () => ({
  useTransactionsScreenData: () => mockTx,
  // The detail screen resolves the row via the shared resolver; back it with the same fixture list.
  useTransactionResolver: () => ({
    transactions: mockTx.transactions,
    findTx: (id: string) => (mockTx.transactions as { transaction_id: string }[]).find((t) => t.transaction_id === id),
  }),
  // WHIT-556: the "Spread this bill" prompt reads budgets from here.
  useBudgetsScreenData: () => ({ budgets: mockBudgets }),
  // WHIT-539: the rule-attribution line. Omitting this crashes every test in the file (the screen
  // destructures its result every render), so it must live in the shared mock.
  useRulesScreenData: () => mockRules,
}));

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
const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: mockId }),
  useRouter: () => ({ back: jest.fn(), push: mockPush }),
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
  mockBudgets = [];
  mockRules = { rules: [], isLoading: false };
  mockPush.mockClear();
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

// ── WHIT-556: the "Spread this bill" prompt ──────────────────────────────────
describe('spread this bill prompt', () => {
  // A spend charge on 'coffee' (the fixture category). Eligibility is driven by the BUDGET's
  // over/under state (mockBudgets), while the prefill comes from the transaction's amount.
  const spendTx = (over = {}) => txData({ transactions: [txn({ transaction_id: 't1', category: 'coffee', amount: -130, ...over })] });

  it('over-budget spend, no plan → shows "Spread a bill in this category" and prefills the OVERAGE', () => {
    mockTx = spendTx();  // the tapped charge is -130, but the prefill is the category overage, not the charge
    mockBudgets = [budget({ id: 'coffee', budget: 100, posted: 130, pending: 0 })];  // over by 30 → start
    render(<TransactionDetail />);

    fireEvent.press(screen.getByTestId('transaction-spread'));
    expect(screen.getByText('Spread a bill in this category')).toBeTruthy();
    expect(mockPush).toHaveBeenCalledWith('/budget/spread?categoryId=coffee&prefill=30');
  });

  it('prefills the OVERAGE, not the tapped charge — a small charge in an over category spreads the overage', () => {
    mockTx = spendTx({ amount: -5 });  // a $5 coffee…
    mockBudgets = [budget({ id: 'coffee', budget: 100, posted: 130.1, pending: 0 })];  // …category over by 30.10
    render(<TransactionDetail />);
    fireEvent.press(screen.getByTestId('transaction-spread'));
    expect(mockPush).toHaveBeenCalledWith('/budget/spread?categoryId=coffee&prefill=30.1');  // not 5
  });

  it('active plan → shows "Edit or remove" and routes with NO prefill (never a second plan)', () => {
    mockTx = spendTx();
    mockBudgets = [budget({ id: 'coffee', budget: 100, posted: 0, pending: 0, spread: { amount: 200, cycles: 4, index: 1, adjustment: -50 } })];
    render(<TransactionDetail />);

    fireEvent.press(screen.getByTestId('transaction-spread'));
    expect(screen.getByText('Edit or remove bill spread')).toBeTruthy();
    expect(mockPush).toHaveBeenCalledWith('/budget/spread?categoryId=coffee');
  });

  it('hidden on a rollover category, even over budget (rollover XOR spread)', () => {
    mockTx = spendTx();
    mockBudgets = [budget({ id: 'coffee', budget: 100, posted: 200, pending: 0, rollover: true, carryover: 0 })];
    render(<TransactionDetail />);
    expect(screen.queryByTestId('transaction-spread')).toBeNull();
  });

  it('hidden for an excluded charge (contributesToBudget false)', () => {
    mockTx = spendTx({ budget_excluded: true });
    mockBudgets = [budget({ id: 'coffee', budget: 100, posted: 130, pending: 0 })];
    render(<TransactionDetail />);
    expect(screen.queryByTestId('transaction-spread')).toBeNull();
  });

  it('hidden for a refund / credit (amount >= 0)', () => {
    mockTx = spendTx({ amount: 50 });
    mockBudgets = [budget({ id: 'coffee', budget: 100, posted: 130, pending: 0 })];
    render(<TransactionDetail />);
    expect(screen.queryByTestId('transaction-spread')).toBeNull();
  });

  it('hidden when the category has no budget', () => {
    mockTx = spendTx();
    mockBudgets = [];  // no budget row for coffee
    render(<TransactionDetail />);
    expect(screen.queryByTestId('transaction-spread')).toBeNull();
  });

  it('does not crash on a not-found transaction (derivations null-guard)', () => {
    mockId = 'missing';
    mockBudgets = [budget({ id: 'coffee', budget: 100, posted: 130, pending: 0 })];
    render(<TransactionDetail />);
    expect(screen.getByText('Transaction not found')).toBeTruthy();
    expect(screen.queryByTestId('transaction-spread')).toBeNull();
  });
});

// ── WHIT-539: "why this category" — name the rule that auto-filed the charge ──
describe('rule attribution line', () => {
  it('names the rule when a description rule filed the charge (happy path)', () => {
    mockTx = txData({ transactions: [txn({ transaction_id: 't1', category: 'coffee', filed_by_rule: 'r1' })] });
    mockRules = { rules: [rule({ id: 'r1', field: 'description', operator: 'contains', pattern: 'COLES', categoryId: 'coffee' })], isLoading: false };
    render(<TransactionDetail />);
    expect(screen.getByTestId('filed-by-rule')).toBeTruthy();
    expect(screen.getByText('Filed by your rule: contains "COLES"')).toBeTruthy();
  });

  // Fail-on-revert (MAJOR-2): a category/equals rule's pattern is a raw enum, not human text.
  // Reverting the field branch in ruleFiledLabel would print "equals FOOD_AND_DRINK".
  it('shows the generic line (not the raw enum) when a category rule filed it', () => {
    mockTx = txData({ transactions: [txn({ transaction_id: 't1', category: 'coffee', filed_by_rule: 'r1' })] });
    mockRules = { rules: [rule({ id: 'r1', field: 'category', operator: 'equals', pattern: 'FOOD_AND_DRINK', categoryId: 'coffee' })], isLoading: false };
    render(<TransactionDetail />);
    expect(screen.getByText('Filed automatically by one of your rules')).toBeTruthy();
    expect(screen.queryByText(/FOOD_AND_DRINK/)).toBeNull();
  });

  // The card's key requirement: a dangling id (rule renamed/deleted) shows a graceful fallback,
  // never a raw id, never an error.
  it('shows the generic fallback for a dangling id, never the raw id', () => {
    mockTx = txData({ transactions: [txn({ transaction_id: 't1', category: 'coffee', filed_by_rule: 'ghost' })] });
    mockRules = { rules: [rule({ id: 'r1' })], isLoading: false };
    render(<TransactionDetail />);
    expect(screen.getByText('Filed automatically by one of your rules')).toBeTruthy();
    expect(screen.queryByText(/ghost/)).toBeNull();
  });

  // Fail-on-revert (MAJOR-3): while the rules cache is loading, show NOTHING — not the generic
  // fallback — so a valid rule-filed charge doesn't flash generic→named on every cold open.
  it('shows no line (and does not crash) while the rules cache is still loading', () => {
    mockTx = txData({ transactions: [txn({ transaction_id: 't1', category: 'coffee', filed_by_rule: 'r1' })] });
    mockRules = { rules: [], isLoading: true };
    render(<TransactionDetail />);
    expect(screen.queryByTestId('filed-by-rule')).toBeNull();
  });

  // Fail-on-revert (BLOCKER): the server clears filed_by_rule on a hand re-file, but the client
  // cache keeps the stale stamp. The category-match gate hides the line when the tagged rule no
  // longer owns the current category. Reverting the gate shows a false "filed by your rule" line.
  it('shows no line when the charge was re-filed by hand (stamp no longer owns the category)', () => {
    mockTx = txData({ transactions: [txn({ transaction_id: 't1', category: 'groceries', filed_by_rule: 'r1' })] });
    mockRules = { rules: [rule({ id: 'r1', categoryId: 'coffee' })], isLoading: false };
    render(<TransactionDetail />);
    expect(screen.queryByTestId('filed-by-rule')).toBeNull();
  });

  it('shows no line when no rule filed the charge (no stamp)', () => {
    mockTx = txData({ transactions: [txn({ transaction_id: 't1', category: 'coffee' })] });
    mockRules = { rules: [rule({ id: 'r1' })], isLoading: false };
    render(<TransactionDetail />);
    expect(screen.queryByTestId('filed-by-rule')).toBeNull();
  });
});
