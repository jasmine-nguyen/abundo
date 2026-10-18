// WHIT-272 — the transaction detail screen (read-only slice). Reached by the row chevron;
// the id in the route is the transaction_id. The transaction comes from the SAME cached
// query the lists use, found by id. WHIT-686: the real screen data code runs over the pretend
// server. Verifies the fields render, the pending label, the "not found" state for a stale id,
// and cache-first error handling.
import { it, expect, jest, beforeEach, describe } from '@jest/globals';
import { routerSpies, setParams, resetRouter } from './support/routerMock';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { ScrollView } from 'react-native';
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
import { installFakeServer, seedFeedPage } from './support/fakeServer';
import { useTestQueryClient, renderWithQueries, refreshInAct, WithQueries } from './support/renderWithQueries';
import { queryClient } from '../queryClient';
import { transactionsKey } from '../queryKeys';
import { removeFromAllCopies } from '../transactionCache';
import { COFFEE_RECORD } from './support/categories';
import { pinToday } from './support/clock';
import { styleOf } from './support/layout';
import { LARGE_TEXT_MAX_SCALE } from '../hooks/useLargeText';

const server = installFakeServer();
useTestQueryClient();

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
  seedFeedPage(server, '/transactions/feed', [txn({ transaction_id: 't1', category: 'coffee' })]);
  mockApplyTransactionEdit.mockClear();
  mockToast.mockClear();
  mockOpenPicker.mockClear();
  mockDeleteTransaction.mockReset();
});

it('renders the transaction fields (merchant, amount, date, account, category, status)', async () => {
  await draw();
  expect(screen.getByText('Woolworths')).toBeTruthy();
  expect(screen.getByText('−\u2060$12.50')).toBeTruthy();
  expect(screen.getByText('1 Jul 2026')).toBeTruthy();
  expect(screen.getByText('Everyday')).toBeTruthy();
  expect(screen.getByText('Cafes & Coffee')).toBeTruthy();
  expect(screen.getByText('Posted')).toBeTruthy();
});

// WHIT-845: at big text the hero amount stays on one line (shrinking to fit, capped at 2×), and the
// tag "×" has no fixed line height to clip it.
it('the hero amount fits one line and the tag "×" is not clipped by a fixed line height', async () => {
  seedFeedPage(server, '/transactions/feed', [txn({ transaction_id: 't1', category: 'coffee', tags: ['work'] })]);
  await draw();
  const amount = screen.getByText('−\u2060$12.50');
  expect(amount.props).toMatchObject({ numberOfLines: 1, adjustsFontSizeToFit: true, maxFontSizeMultiplier: LARGE_TEXT_MAX_SCALE });
  expect(styleOf(screen.getByText('×')).lineHeight).toBeUndefined();
});

it('shows Pending with its age for a pending transaction 7 days old', async () => {
  pinToday(new Date('2026-07-08T08:00:00+10:00'));
  try {
    seedFeedPage(server, '/transactions/feed', [txn({ transaction_id: 't1', category: 'coffee', status: 'pending', date: '2026-07-01' })]);
    await draw();
    expect(screen.getByText('Pending · 7 days')).toBeTruthy();
  } finally {
    jest.useRealTimers();
  }
});

it('finds a row that is only in the recent list (not the feed)', async () => {
  seedFeedPage(server, '/transactions/feed', []);
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

// [A-detail-undef] CONSISTENCY: when the server omits counts_to_budget, the detail screen shows
// the plain "not counted" line (ABU-99: no "Excluded (transfer)" box title) and hides the toggle (it gates on the falsy
// counts_to_budget test), rather than a contradictory OFF switch. Fails if the gate reverts to a
// strict `=== false` (which would fall through to the toggle for undefined).
it('shows the read-only note (not the toggle) when counts_to_budget is undefined — matching the list tag', async () => {
  seedFeedPage(server, '/transactions/feed', [txn({ transaction_id: 't1', category: 'coffee', counts_to_budget: undefined })]);
  await draw();
  expect(screen.getByText('Transfer or card payment. Not counted in budgets or insights.')).toBeTruthy();
  expect(screen.queryByRole('switch', { name: 'Exclude from budgets' })).toBeNull();
});

// ABU-99: the redesigned page — the amount is the star with the shop name under it, the Account
// row opens that account's page, an empty note and tags fold to "Add" lines, delete is a quiet
// link, and the title bar gets an edge once the page scrolls.
it('the amount leads, Account opens its page, empty note/tags fold, and the title edges on scroll', async () => {
  await draw();

  const amount = screen.getByText('−⁠$12.50');
  const merchant = screen.getByText('Woolworths');
  expect(screen.root.findAll((n) => n === amount || n === merchant)).toEqual([amount, merchant]);
  expect(styleOf(amount).fontSize).toBeGreaterThanOrEqual(2 * styleOf(merchant).fontSize);

  fireEvent.press(screen.getByRole('button', { name: 'Open account Everyday' }));
  expect(routerSpies.push).toHaveBeenCalledWith('/account/a1');

  expect(screen.queryByTestId('note-input')).toBeNull();
  expect(screen.queryByTestId('tag-input')).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: 'Add note' }));
  expect(screen.getByTestId('note-input')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Add tag' }));
  expect(screen.getByTestId('tag-input')).toBeTruthy();

  expect(styleOf(screen.getByTestId('transaction-delete')).backgroundColor).toBeUndefined();

  const scroller = screen.UNSAFE_getByType(ScrollView);
  expect(styleOf(screen.getByTestId('header-wrap')).borderBottomWidth ?? 0).toBe(0);
  fireEvent.scroll(scroller, { nativeEvent: { contentOffset: { x: 0, y: 40 } } });
  expect(styleOf(screen.getByTestId('header-wrap')).borderBottomWidth).toBeGreaterThan(0);
  fireEvent.scroll(scroller, { nativeEvent: { contentOffset: { x: 0, y: 0 } } });
  expect(styleOf(screen.getByTestId('header-wrap')).borderBottomWidth ?? 0).toBe(0);
});

// ===== WHIT-276 (folded from transactionDetailStates.screen.test.tsx)

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

// WHIT-328: unlike its quiet, non-tappable list row, a not-in-budget uncategorized charge can
// still be re-filed from the detail screen.
it('detail screen labels the Category "Uncategorized" and re-opens the picker on tap', async () => {
  seedFeedPage(server, '/transactions/feed', [txn({ transaction_id: 't1', category: null, counts_to_budget: false })]);
  await draw();
  expect(screen.getByText('Uncategorised')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('Change category, currently Uncategorised'));
  expect(mockOpenPicker).toHaveBeenCalledWith('t1');
});

// ── WHIT-556: the "Spread this bill" prompt ──────────────────────────────────
describe('spread this bill prompt', () => {
  // A spend charge on 'coffee' (the fixture category). Eligibility is driven by the BUDGET's
  // over/under state (the /budgets rollup), while the prefill comes from the category overage.
  const seedSpend = (over: Partial<Transaction> = {}) =>
    seedFeedPage(server, '/transactions/feed', [txn({ transaction_id: 't1', category: 'coffee', amount: -130, ...over })]);

  it('over-budget spend, no plan → shows "Spread a bill in this category" and prefills the OVERAGE', async () => {
    seedSpend();  // the tapped charge is -130, but the prefill is the category overage, not the charge
    server.seed('/budgets', { coffee: rollup({ target: 100, posted: 130, pending: 0 }) });  // over by 30 → start
    await draw();

    fireEvent.press(screen.getByRole('button', { name: 'Spread a bill in this category' }));
    expect(routerSpies.push).toHaveBeenCalledWith('/budget/spread?categoryId=coffee&prefill=30');
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

  it.each([
    ['an excluded charge (contributesToBudget false)', { budget_excluded: true }],
    ['a refund / credit (amount >= 0)', { amount: 50 }],
  ])('hidden for %s', async (_name, over) => {
    seedSpend(over);
    server.seed('/budgets', { coffee: rollup({ target: 100, posted: 130, pending: 0 }) });
    await draw();
    expect(screen.queryByTestId('transaction-spread')).toBeNull();
  });

  // ABU-83: a charge filed in a "Transfer, not spending" category never counts, so the screen
  // explains why (no manual exclude switch) and offers no bill spread, even when over budget.
  it('a charge in a transfer category shows the note, not the switch, and no spread offer', async () => {
    server.seed('/categories', [{ ...COFFEE_RECORD, parent: null, transfer: true }]);
    seedFeedPage(server, '/transactions/feed', [txn({ transaction_id: 't1', category: 'coffee', amount: -130 })]);
    server.seed('/budgets', { coffee: rollup({ target: 100, posted: 130, pending: 0 }) });
    await draw();

    expect(screen.getByText(`${COFFEE_RECORD.name} is a transfer. Not counted in budgets or insights.`)).toBeTruthy();
    expect(screen.queryByRole('switch', { name: 'Exclude from budgets' })).toBeNull();
    expect(screen.queryByTestId('transaction-spread')).toBeNull();
  });
});

// ── WHIT-539: "why this category" — name the rule that auto-filed the charge ──
describe('rule attribution line', () => {
  const seedStamped = (filedByRule: string, category: string | null = 'coffee') =>
    seedFeedPage(server, '/transactions/feed', [txn({ transaction_id: 't1', category, filed_by_rule: filedByRule })]);

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

  function openConfirm() {
    fireEvent.press(screen.getByTestId('transaction-delete'));
    return alerts.last().button('Delete');
  }

  it('a double confirm in the same frame deletes once and goes back once', async () => {
    mockDeleteTransaction.mockResolvedValue(true);
    await draw();
    const confirm = openConfirm();

    await refreshInAct(() => { confirm.onPress?.(); confirm.onPress?.(); });

    expect(mockDeleteTransaction).toHaveBeenCalledTimes(1);
    expect(routerSpies.back).toHaveBeenCalledTimes(1);
  });

  it('a writer that throws leaves the user on the screen with the button re-enabled', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockDeleteTransaction.mockRejectedValue(new Error('boom'));
    await draw();

    await refreshInAct(() => { openConfirm().onPress?.(); });

    expect(routerSpies.back).not.toHaveBeenCalled();
    expect(screen.getByTestId('transaction-delete').props.accessibilityState).toEqual({ disabled: false });
    consoleError.mockRestore();
  });

  // The delete empties every list cache and the feed is reloading with nothing cached — the
  // screen would normally show its spinner, but it keeps the charge up until the delete answers.
  it('deleting the ONLY cached charge never flashes the empty/loading states before going back', async () => {
    let finish: (ok: boolean) => void = () => {};
    mockDeleteTransaction.mockImplementation(() => {
      void queryClient.resetQueries({ queryKey: transactionsKey });
      return new Promise((resolve) => { finish = resolve; });
    });
    await draw();
    const reload = server.hold('/transactions/feed');

    await refreshInAct(() => { openConfirm().onPress?.(); });

    expect(queryClient.getQueryState(transactionsKey)?.status).toBe('pending');
    expect(screen.queryByTestId('transaction-loading')).toBeNull();
    expect(screen.queryByText('Transaction not found')).toBeNull();
    expect(screen.getByTestId('transaction-delete')).toBeTruthy();

    await refreshInAct(() => finish(true));
    expect(routerSpies.back).toHaveBeenCalledTimes(1);
    await refreshInAct(() => reload.release());
  });

  // WHIT-843: leaving saves an edited note, but not after a delete — the charge is gone. A FAILED
  // delete keeps the charge, so leaving still saves the note.
  it.each([
    { result: 'succeeds', ok: true, backs: 1, saves: 0 },
    { result: 'fails', ok: false, backs: 0, saves: 1 },
  ])('when the delete $result, leaving saves the edited note $saves time(s)', async ({ ok, backs, saves }) => {
    let finish: (done: boolean) => void = () => {};
    mockDeleteTransaction.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const view = await draw();
    fireEvent.press(screen.getByTestId('note-add'));
    fireEvent.changeText(screen.getByTestId('note-input'), 'edited');

    await refreshInAct(() => { openConfirm().onPress?.(); });  // the screen draws mid-delete
    await refreshInAct(() => finish(ok));
    view.unmount();

    expect(routerSpies.back).toHaveBeenCalledTimes(backs);
    expect(mockApplyTransactionEdit).toHaveBeenCalledTimes(saves);
  });
});
