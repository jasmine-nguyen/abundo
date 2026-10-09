// WHIT-272 — the transaction detail screen (read-only slice). Reached by the row chevron;
// the id in the route is the transaction_id. The transaction comes from the SAME cached
// query the lists use, found by id. WHIT-686: the real screen data code runs over the pretend
// server. Verifies the fields render, the pending label, the "not found" state for a stale id,
// and cache-first error handling.
import { it, expect, jest, beforeEach, describe } from '@jest/globals';
import { routerSpies, setParams, resetRouter } from './support/routerMock';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { budgetRow, txn } from './factory';
import type { Transaction } from '../types';
import type { BudgetRollup, RuleRecord } from '../api';

// WHIT-275: the screen's note/tags editor reads applyTransactionEdit from the context; stub
// it (real selectors kept) so these read-path tests render without an AppProvider.
// WHIT-459: the context stub is the SUPERSET of the folded siblings' stubs.
const mockApplyTransactionEdit = jest.fn();
const mockToast = jest.fn();
const mockOpenPicker = jest.fn();
const mockDeleteTransaction = jest.fn<(txId: string) => Promise<boolean>>();
jest.mock('../context', () =>
  require('./support/contextMock').realContextWith(() => ({
    applyTransactionEdit: mockApplyTransactionEdit,
    showToast: mockToast,
    openPicker: mockOpenPicker,
    deleteTransaction: mockDeleteTransaction,
  })),
);
jest.mock('../auth', () => require('./support/authMock').authMockModule());

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import TransactionDetail from '../../app/transaction/[id]';
import { resetAuth } from './support/authMock';
import { pressAlertButton, spyOnAlert } from './support/alertSpy';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient, renderWithQueries, refreshInAct, WithQueries } from './support/renderWithQueries';
import { queryClient } from '../queryClient';
import { transactionsKey } from '../queryKeys';
import { removeFromAllCopies } from '../transactionCache';
import { COFFEE_RECORD } from './support/categories';

const server = installFakeServer();
useTestQueryClient();

function seedFeed(transactions: Transaction[]) {
  server.seed('/transactions/feed', { transactions, nextCursor: null });
}

const rollup = (over: Partial<BudgetRollup> = {}): BudgetRollup => ({ target: 100, posted: 40, pending: 10, ...over });

const ruleRecord = (over: Partial<RuleRecord> = {}): RuleRecord => ({
  id: 'r1', field: 'description', operator: 'contains', value: 'COLES', categoryId: 'coffee', ...over,
});

const draw = () => renderWithQueries(<TransactionDetail />);

const feedReads = () => server.sentUnder('GET', '/transactions/feed').length;

beforeEach(() => {
  resetRouter();
  resetAuth();
  setParams({ id: 't1' });
  server.seed('/categories', [{ ...COFFEE_RECORD, parent: null }]);
  seedFeed([txn({ transaction_id: 't1', category: 'coffee' })]);
  mockApplyTransactionEdit.mockClear();
  mockToast.mockClear();
  mockOpenPicker.mockClear();
  mockDeleteTransaction.mockReset();
});

it('renders the transaction fields (merchant, amount, date, account, category, status)', async () => {
  await draw();
  expect(screen.getByText('Woolworths')).toBeTruthy();
  expect(screen.getByText('-$12.50')).toBeTruthy();
  expect(screen.getByText('1 Jul 2026')).toBeTruthy();
  expect(screen.getByText('Everyday')).toBeTruthy();
  expect(screen.getByText('Cafes & Coffee')).toBeTruthy();
  expect(screen.getByText('Posted')).toBeTruthy();
});

it('shows Pending for a pending transaction', async () => {
  seedFeed([txn({ transaction_id: 't1', category: 'coffee', status: 'pending' })]);
  await draw();
  expect(screen.getByText('Pending')).toBeTruthy();
});

it('finds a row that is only in the recent list (not the feed)', async () => {
  seedFeed([]);
  server.seed('/transactions', [txn({ transaction_id: 't1', category: 'coffee' })]);
  await draw();
  expect(screen.getByText('Woolworths')).toBeTruthy();
});

it('shows a not-found state when no transaction carries the route id (stale link)', async () => {
  setParams({ id: 'ghost' });
  await draw();
  expect(screen.getByText('Transaction not found')).toBeTruthy();
});

it('a hard read failure with nothing cached shows the inline error + an accessible Retry', async () => {
  server.fail('/transactions/feed', 500);
  await draw();

  expect(screen.getByTestId('transaction-error')).toBeTruthy();
  const retry = screen.getByTestId('transaction-retry');
  expect(retry.props.accessibilityRole).toBe('button');
  expect(retry.props.accessibilityLabel).toBe('Retry loading this transaction');

  const before = feedReads();
  await refreshInAct(() => fireEvent.press(retry));
  await waitFor(() => expect(feedReads()).toBe(before + 1));
});

it('does NOT show the error when a background refetch fails over cached rows (cache-first)', async () => {
  await draw();
  server.once('GET', '/transactions/feed', { status: 500 });
  await refreshInAct(() => queryClient.refetchQueries({ queryKey: transactionsKey }));

  expect(queryClient.getQueryState(transactionsKey)?.status).toBe('error');
  expect(screen.queryByTestId('transaction-error')).toBeNull();
  expect(screen.getByText('Woolworths')).toBeTruthy();
});

// [A-loading-gate] (adversarial gap) Genuinely loading with an EMPTY cache: showSpinner is true, so
// the "not found" branch (which also matches when transaction is undefined) MUST stay hidden.
// A revert that drops the `!showSpinner` guard on the empty state would flash "not found" under
// every cold load — this test fails if that happens.
it('while loading with nothing cached, shows the spinner and NOT the not-found state', async () => {
  const held = server.hold('/transactions/feed');
  render(<WithQueries><TransactionDetail /></WithQueries>);
  expect(await screen.findByTestId('transaction-loading')).toBeTruthy();
  expect(screen.queryByText('Transaction not found')).toBeNull();
  await refreshInAct(() => held.release());
});

// ===== WHIT-298 (folded from transactionDetailExcludedEdges.screen.test.tsx)

// [A-detail-combo] the bank flag wins: even with the user's budget_excluded also set, the screen
// shows the read-only note and hides the (would-be inert) manual toggle.
it('shows the read-only note and NO toggle when bank-excluded AND user-excluded', async () => {
  seedFeed([txn({ transaction_id: 't1', category: 'coffee', counts_to_budget: false, budget_excluded: true })]);
  await draw();
  expect(screen.getByText('Excluded (transfer)')).toBeTruthy();
  expect(screen.queryByRole('switch', { name: 'Exclude from budgets' })).toBeNull();
});

// [A-detail-undef] CONSISTENCY: when the server omits counts_to_budget, the detail screen shows
// the read-only "Excluded (transfer)" note and hides the toggle (it gates on the falsy
// counts_to_budget test), rather than a contradictory OFF switch. Fails if the gate reverts to a
// strict `=== false` (which would fall through to the toggle for undefined).
it('shows the read-only note (not the toggle) when counts_to_budget is undefined — matching the list tag', async () => {
  seedFeed([txn({ transaction_id: 't1', category: 'coffee', counts_to_budget: undefined })]);
  await draw();
  expect(screen.getByText('Excluded (transfer)')).toBeTruthy();
  expect(screen.queryByRole('switch', { name: 'Exclude from budgets' })).toBeNull();
});

// ===== WHIT-276 (folded from transactionDetailStates.screen.test.tsx)

// [A-txn-both] Empty cache, still loading AND errored: through the real screen both the
// spinner and the error render stacked and the "not found" empty message stays hidden. A
// collapse to either/or, or dropping the hasCache gate, breaks this.
it('with an empty cache, isLoading && isError renders BOTH the spinner and the error, not the not-found state', async () => {
  const held = server.hold('/transactions/feed');
  server.fail('/categories', 500);
  render(<WithQueries><TransactionDetail /></WithQueries>);
  expect(await screen.findByTestId('transaction-error')).toBeTruthy();
  expect(screen.getByTestId('transaction-loading')).toBeTruthy();
  expect(screen.queryByText('Transaction not found')).toBeNull();
  await refreshInAct(() => held.release());
});

// ===== WHIT-287 (folded from transactionRecategorize.screen.test.tsx)

it('tapping the Category row opens the picker for this transaction', async () => {
  await draw();
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
  it('an income-tagged transaction is re-filable', async () => {
    seedFeed([txn({ transaction_id: 't1', category: 'income', amount: 2500 })]);
    await draw();
    fireEvent.press(screen.getByLabelText('Change category, currently Income'));
    expect(mockOpenPicker).toHaveBeenCalledWith('t1');
  });

  it('an uncategorized transaction is re-filable', async () => {
    seedFeed([txn({ transaction_id: 't1', category: null })]);
    await draw();
    fireEvent.press(screen.getByLabelText('Change category, currently Uncategorized'));
    expect(mockOpenPicker).toHaveBeenCalledWith('t1');
  });

  it('a pending transaction is re-filable', async () => {
    seedFeed([txn({ transaction_id: 't1', category: 'coffee', status: 'pending' })]);
    await draw();
    fireEvent.press(screen.getByLabelText('Change category, currently Cafes & Coffee'));
    expect(mockOpenPicker).toHaveBeenCalledWith('t1');
  });
});

it('the picker targets the routed transaction id (not a hardcoded one)', async () => {
  setParams({ id: 't2' });
  seedFeed([txn({ transaction_id: 't2', category: 'coffee' })]);
  await draw();
  fireEvent.press(screen.getByLabelText('Change category, currently Cafes & Coffee'));
  expect(mockOpenPicker).toHaveBeenCalledWith('t2');
});

// ── WHIT-556: the "Spread this bill" prompt ──────────────────────────────────
describe('spread this bill prompt', () => {
  // A spend charge on 'coffee' (the fixture category). Eligibility is driven by the BUDGET's
  // over/under state (the /budgets rollup), while the prefill comes from the category overage.
  const seedSpend = (over: Partial<Transaction> = {}) =>
    seedFeed([txn({ transaction_id: 't1', category: 'coffee', amount: -130, ...over })]);

  it('over-budget spend, no plan → shows "Spread a bill in this category" and prefills the OVERAGE', async () => {
    seedSpend();  // the tapped charge is -130, but the prefill is the category overage, not the charge
    server.seed('/budgets', { coffee: rollup({ target: 100, posted: 130, pending: 0 }) });  // over by 30 → start
    await draw();

    fireEvent.press(screen.getByTestId('transaction-spread'));
    expect(screen.getByText('Spread a bill in this category')).toBeTruthy();
    expect(routerSpies.push).toHaveBeenCalledWith('/budget/spread?categoryId=coffee&prefill=30');
  });

  it('prefills the OVERAGE, not the tapped charge — a small charge in an over category spreads the overage', async () => {
    seedSpend({ amount: -5 });  // a $5 coffee…
    server.seed('/budgets', { coffee: rollup({ target: 100, posted: 130.1, pending: 0 }) });  // …category over by 30.10
    await draw();
    fireEvent.press(screen.getByTestId('transaction-spread'));
    expect(routerSpies.push).toHaveBeenCalledWith('/budget/spread?categoryId=coffee&prefill=30.1');  // not 5
  });

  it('active plan → shows "Edit or remove" and routes with NO prefill (never a second plan)', async () => {
    seedSpend();
    server.seed('/budgets', {
      coffee: budgetRow({ target: 100, posted: 0, pending: 0, spread: { amount: 200, cycles: 4, index: 1, adjustment: -50 } }),
    });
    await draw();

    fireEvent.press(screen.getByTestId('transaction-spread'));
    expect(screen.getByText('Edit or remove bill spread')).toBeTruthy();
    expect(routerSpies.push).toHaveBeenCalledWith('/budget/spread?categoryId=coffee');
  });

  it('hidden on a rollover category, even over budget (rollover XOR spread)', async () => {
    seedSpend();
    server.seed('/budgets', { coffee: rollup({ target: 100, posted: 200, pending: 0, rollover: true, carryover: 0 }) });
    await draw();
    expect(screen.queryByTestId('transaction-spread')).toBeNull();
  });

  it('hidden for an excluded charge (contributesToBudget false)', async () => {
    seedSpend({ budget_excluded: true });
    server.seed('/budgets', { coffee: rollup({ target: 100, posted: 130, pending: 0 }) });
    await draw();
    expect(screen.queryByTestId('transaction-spread')).toBeNull();
  });

  it('hidden for a refund / credit (amount >= 0)', async () => {
    seedSpend({ amount: 50 });
    server.seed('/budgets', { coffee: rollup({ target: 100, posted: 130, pending: 0 }) });
    await draw();
    expect(screen.queryByTestId('transaction-spread')).toBeNull();
  });

  it('hidden when the category has no budget', async () => {
    seedSpend();
    server.seed('/budgets', {});  // no budget row for coffee
    await draw();
    expect(screen.queryByTestId('transaction-spread')).toBeNull();
  });

  it('does not crash on a not-found transaction (derivations null-guard)', async () => {
    setParams({ id: 'missing' });
    server.seed('/budgets', { coffee: rollup({ target: 100, posted: 130, pending: 0 }) });
    await draw();
    expect(screen.getByText('Transaction not found')).toBeTruthy();
    expect(screen.queryByTestId('transaction-spread')).toBeNull();
  });
});

// ── WHIT-539: "why this category" — name the rule that auto-filed the charge ──
describe('rule attribution line', () => {
  const seedStamped = (filedByRule: string, category: string | null = 'coffee') =>
    seedFeed([txn({ transaction_id: 't1', category, filed_by_rule: filedByRule })]);

  it('names the rule when a description rule filed the charge (happy path)', async () => {
    seedStamped('r1');
    server.seed('/rules', [ruleRecord({ id: 'r1', field: 'description', operator: 'contains', value: 'COLES', categoryId: 'coffee' })]);
    await draw();
    expect(screen.getByTestId('filed-by-rule')).toBeTruthy();
    expect(screen.getByText('Filed by your rule: contains "COLES"')).toBeTruthy();
  });

  // Fail-on-revert (MAJOR-2): a category/equals rule's pattern is a raw enum, not human text.
  // Reverting the field branch in ruleFiledLabel would print "equals FOOD_AND_DRINK".
  it('shows the generic line (not the raw enum) when a category rule filed it', async () => {
    seedStamped('r1');
    server.seed('/rules', [ruleRecord({ id: 'r1', field: 'category', operator: 'equals', value: 'FOOD_AND_DRINK', categoryId: 'coffee' })]);
    await draw();
    expect(screen.getByText('Filed automatically by one of your rules')).toBeTruthy();
    expect(screen.queryByText(/FOOD_AND_DRINK/)).toBeNull();
  });

  // The card's key requirement: a dangling id (rule renamed/deleted) shows a graceful fallback,
  // never a raw id, never an error.
  it('shows the generic fallback for a dangling id, never the raw id', async () => {
    seedStamped('ghost');
    server.seed('/rules', [ruleRecord({ id: 'r1' })]);
    await draw();
    expect(screen.getByText('Filed automatically by one of your rules')).toBeTruthy();
    expect(screen.queryByText(/ghost/)).toBeNull();
  });

  // Fail-on-revert (MAJOR-3): while the rules cache is loading, show NOTHING — not the generic
  // fallback — so a valid rule-filed charge doesn't flash generic→named on every cold open.
  it('shows no line (and does not crash) while the rules cache is still loading', async () => {
    seedStamped('r1');
    const held = server.hold('/rules');
    render(<WithQueries><TransactionDetail /></WithQueries>);
    expect(await screen.findByText('Woolworths')).toBeTruthy();
    expect(server.sent('GET', '/rules')).toHaveLength(1);
    expect(screen.queryByTestId('filed-by-rule')).toBeNull();
    await refreshInAct(() => held.release());
  });

  // Fail-on-revert (BLOCKER): the server clears filed_by_rule on a hand re-file, but the client
  // cache keeps the stale stamp. The category-match gate hides the line when the tagged rule no
  // longer owns the current category. Reverting the gate shows a false "filed by your rule" line.
  it('shows no line when the charge was re-filed by hand (stamp no longer owns the category)', async () => {
    seedStamped('r1', 'groceries');
    server.seed('/rules', [ruleRecord({ id: 'r1', categoryId: 'coffee' })]);
    await draw();
    expect(screen.queryByTestId('filed-by-rule')).toBeNull();
  });

  it('shows no line when no rule filed the charge (no stamp)', async () => {
    server.seed('/rules', [ruleRecord({ id: 'r1' })]);
    await draw();
    expect(screen.queryByTestId('filed-by-rule')).toBeNull();
  });

  // [A-mult] Fail-on-revert: two rules file into the SAME category; the stamp points at r2. The
  // lookup must match by ID, not by category — matching by category would name r1's pattern.
  it('resolves the stamped rule by id, not by category, when two rules share a category', async () => {
    seedStamped('r2');
    server.seed('/rules', [
      ruleRecord({ id: 'r1', value: 'COLES', categoryId: 'coffee' }),
      ruleRecord({ id: 'r2', value: 'WOOLIES', categoryId: 'coffee' }),
    ]);
    await draw();
    expect(screen.getByText('Filed by your rule: contains "WOOLIES"')).toBeTruthy();
    expect(screen.queryByText(/COLES/)).toBeNull();
  });

  // [A-empty] An empty-string stamp is a falsy, malformed id: treat it as "no rule" — no line,
  // no crash, no fallback. Fail-on-revert: a `!== undefined` guard would make '' truthy → an
  // unmatched find → a false generic fallback.
  it('shows no line for an empty-string filed_by_rule (falsy id)', async () => {
    seedStamped('');
    server.seed('/rules', [ruleRecord({ id: 'r1' })]);
    await draw();
    expect(screen.queryByTestId('filed-by-rule')).toBeNull();
  });

  // [A-nullcat] A matched rule but the charge's category is null (re-filed to Uncategorized while the
  // stale stamp lingers): the category-match gate fails → no line. Fail-on-revert: dropping the gate
  // would show "filed by your rule" on an uncategorised row.
  it('shows no line when the charge category is null even though the rule is present', async () => {
    seedStamped('r1', null);
    server.seed('/rules', [ruleRecord({ id: 'r1', categoryId: 'coffee' })]);
    await draw();
    expect(screen.queryByTestId('filed-by-rule')).toBeNull();
  });

  // [A-acc] The note carries the same human text as its screen-reader label. Fail-on-revert:
  // removing accessibilityLabel={text} from RuleFiledNote makes getByLabelText miss.
  it('exposes the rule text as the accessibility label', async () => {
    seedStamped('r1');
    server.seed('/rules', [ruleRecord({ id: 'r1', value: 'COLES', field: 'description', operator: 'contains', categoryId: 'coffee' })]);
    await draw();
    expect(screen.getByLabelText('Filed by your rule: contains "COLES"')).toBeTruthy();
  });
});

// WHIT-654: delete a charge (e.g. a duplicate) from its detail screen, behind a confirmation.
describe('delete this transaction', () => {
  const alerts = spyOnAlert();

  function tapDeleteAndChoose(choice: 'Cancel' | 'Delete') {
    fireEvent.press(screen.getByTestId('transaction-delete'));
    expect(alerts.spy).toHaveBeenCalledTimes(1);
    expect(alerts.last().title).toBe('Delete this transaction?');
    pressAlertButton(alerts, choice);
  }

  it('asks for confirmation, and Cancel deletes nothing', async () => {
    await draw();
    tapDeleteAndChoose('Cancel');
    expect(mockDeleteTransaction).not.toHaveBeenCalled();
    expect(routerSpies.back).not.toHaveBeenCalled();
  });

  it('confirming deletes the charge and goes back, never flashing "Transaction not found"', async () => {
    let finish: (ok: boolean) => void = () => {};
    mockDeleteTransaction.mockImplementation((txId) => {
      // The real action drops the charge from every cache before the server answers.
      removeFromAllCopies(txId);
      return new Promise((resolve) => { finish = resolve; });
    });
    await draw();

    await refreshInAct(() => tapDeleteAndChoose('Delete'));

    expect(mockDeleteTransaction).toHaveBeenCalledWith('t1');
    expect(queryClient.getQueryData<{ pages: { transactions: Transaction[] }[] }>(transactionsKey)?.pages[0].transactions).toEqual([]);
    expect(screen.queryByText('Transaction not found')).toBeNull();
    expect(screen.getByText('Woolworths')).toBeTruthy();
    expect(routerSpies.back).not.toHaveBeenCalled();

    await refreshInAct(() => finish(true));
    expect(routerSpies.back).toHaveBeenCalledTimes(1);
  });

  it('a failed delete stays on the screen so the user can retry', async () => {
    mockDeleteTransaction.mockResolvedValue(false);
    await draw();

    await refreshInAct(() => tapDeleteAndChoose('Delete'));

    expect(routerSpies.back).not.toHaveBeenCalled();
    expect(screen.getByTestId('transaction-delete').props.accessibilityState).toEqual({ disabled: false });
  });
});
