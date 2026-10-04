// The budget-detail related-transactions list now shows the WHOLE cycle (server-filtered
// to the subtree), paged client-side: first 7 rows, then a "Load More" button reveals the
// next page. Locks that the list is not truncated to a fixed slice and Load More works.
// The categories, budget rollup, the budget's cycle charges and the pay cycle come from the fake
// server through the real query hooks (WHIT-672); ../context keeps only the writers
// (deleteBudget, openPicker); expo-router stubbed.
// WHIT-459: budgetDetailRefile / budgetDetailDelete / budgetDetailPayCycleError /
// budgetDetailRowTargets are folded in as child describes at the END of this file. All five
// share the same ../context + expo-router mocks (module-scope mock fns below) and each folded
// block re-seeds the server in its own beforeEach.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { screen, fireEvent, act, waitFor } from '@testing-library/react-native';

// Superset of the folded files' router/context handles: the delete block asserts back() + the
// writer, refile/rowTargets assert push(), rowTargets asserts openPicker(). Each is hoistable
// into the jest.mock factories (name starts with `mock`) and read lazily at render time; every
// folded block clears + asserts only the ones it needs (clearMocks:true also zeroes call records).
const mockPush = jest.fn();
const mockBack = jest.fn();
const mockDeleteBudget = jest.fn(async (_id: string) => true);
const mockOpenPicker = jest.fn();

jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ deleteBudget: mockDeleteBudget, openPicker: mockOpenPicker }) };
});
jest.mock('../auth', () => require('./support/authMock').authMockModule());

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: mockBack }),
  useLocalSearchParams: () => ({ id: 'coffee' }),
}));

import BudgetDetail from '../../app/budget/[id]';
import { BudgetBar } from '../components/ui';
import { resetAuth } from './support/authMock';
import { pressAlertButton, spyOnAlert } from './support/alertSpy';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { COFFEE as COFFEE_CATEGORY } from './support/categories';

const server = installFakeServer();
useTestQueryClient();

beforeEach(() => resetAuth());

const CATS = [{ ...COFFEE_CATEGORY, recent: 0 }];
const COFFEE = { target: 80, posted: 52, pending: 0 };

// A 30-day cycle with the server's own countdown, so daysLeft never follows the real clock.
function seedDetail({ budget, transactions, daysLeft = 5 }: {
  budget: { target: number; posted: number; pending: number };
  transactions: unknown[];
  daysLeft?: number;
}) {
  server.seed('/categories', CATS);
  server.seed('/budgets', { coffee: budget });
  server.seed('/budgets/coffee/transactions', transactions);
  server.seed('/paycycle', { length: 30, last_pay_date: '2026-07-01', days_left: daysLeft });
}

// 9 cycle charges, all one date so they form a single group rendered in list order.
function nCharges(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    transaction_id: `t${i + 1}`, date: '2026-07-20', authorized_date: '2026-07-20',
    description: `CAFE ${i + 1}`, merchant_name: `Cafe ${i + 1}`, amount: -5,
    account_id: 'a1', account_name: 'Everyday', category: 'coffee',
    status: 'posted', type: 'purchase', counts_to_budget: true,
  }));
}

it('shows the first 7 rows with a Load More button, then reveals the rest on press', async () => {
  seedDetail({ budget: COFFEE, transactions: nCharges(9) });
  await renderWithQueries(<BudgetDetail />);

  expect(screen.getAllByLabelText('View transaction details')).toHaveLength(7);
  const loadMore = screen.getByTestId('budget-load-more');

  fireEvent.press(loadMore);

  expect(screen.getAllByLabelText('View transaction details')).toHaveLength(9);
  // All revealed → the button is gone.
  expect(screen.queryByTestId('budget-load-more')).toBeNull();
});

it('shows no Load More button when the cycle has 7 or fewer charges', async () => {
  seedDetail({ budget: COFFEE, transactions: nCharges(7) });
  await renderWithQueries(<BudgetDetail />);

  expect(screen.getAllByLabelText('View transaction details')).toHaveLength(7);
  expect(screen.queryByTestId('budget-load-more')).toBeNull();
});

it('shows the empty copy when the budget has no charges this cycle', async () => {
  seedDetail({ budget: COFFEE, transactions: [] });
  await renderWithQueries(<BudgetDetail />);

  expect(screen.queryByLabelText('View transaction details')).toBeNull();
  expect(screen.getByText('No transactions in this category this cycle.')).toBeTruthy();
});

// ===== QA gap (folded in): Load More across a DATE BOUNDARY =====
// The tests above put all 9 charges on ONE date (a single group), so they can't catch a regression
// where the screen groups the WHOLE list then pages groups, instead of paging ROWS then grouping
// the slice. Here the 7-row page boundary falls in the MIDDLE of a date's charges — a PARTIAL
// second date-group, which only slice-then-group can produce. Own beforeEach: a two-date fixture.
const COFFEE_BOUNDARY = { target: 80, posted: 50, pending: 0 };

// 4 charges on the newer date, then 6 on the older date (newest-first, as the server sends).
function charge(i: number, date: string) {
  return {
    transaction_id: `t${i}`, date, authorized_date: date,
    description: `CAFE ${i}`, merchant_name: `Cafe ${i}`, amount: -5,
    account_id: 'a1', account_name: 'Everyday', category: 'coffee',
    status: 'posted', type: 'purchase', counts_to_budget: true,
  };
}
function twoDayCharges() {
  const dayA = [1, 2, 3, 4].map((i) => charge(i, '2020-01-04'));   // dates far in the past → stable labels
  const dayB = [5, 6, 7, 8, 9, 10].map((i) => charge(i, '2020-01-03'));
  return [...dayA, ...dayB];
}

describe('Load More across a date boundary', () => {
  beforeEach(() => {
    seedDetail({ budget: COFFEE_BOUNDARY, transactions: twoDayCharges() });
  });

  // [A-loadmore-boundary] the first page is 7 ROWS spanning both dates — the older date-group is
  // shown PARTIALLY (Cafe 5-7 visible, Cafe 8-10 hidden). Grouping the whole list then paging
  // groups could never show a partial group.
  it('pages rows (not groups): the first page shows a PARTIAL second date-group', async () => {
    await renderWithQueries(<BudgetDetail />);

    expect(screen.getAllByLabelText('View transaction details')).toHaveLength(7);
    expect(screen.getByText('Cafe 4')).toBeTruthy();   // last of day A
    expect(screen.getByText('Cafe 7')).toBeTruthy();   // day B, within the first page
    expect(screen.queryByText('Cafe 8')).toBeNull();   // day B, but past the 7-row cut → hidden
    expect(screen.queryByText('Cafe 10')).toBeNull();
  });

  // [A-loadmore-boundary-reveal] Load More reveals the rest of the older date's group; the button
  // then disappears (all 10 revealed).
  it('Load More reveals the rest of the split date-group, then hides the button', async () => {
    await renderWithQueries(<BudgetDetail />);
    fireEvent.press(screen.getByTestId('budget-load-more'));

    expect(screen.getAllByLabelText('View transaction details')).toHaveLength(10);
    expect(screen.getByText('Cafe 8')).toBeTruthy();
    expect(screen.getByText('Cafe 10')).toBeTruthy();
    expect(screen.queryByTestId('budget-load-more')).toBeNull();
  });

  // [A-loadmore-two-groups] the first page renders BOTH date headings (the slice crosses the
  // boundary), proving the slice is grouped — not just row-capped within one group.
  it('renders both date-group headings on the first page (slice is grouped by date)', async () => {
    await renderWithQueries(<BudgetDetail />);
    // dateLabel formats a far-past date as "<weekday> <d> <mon>": 2020-01-04 = Sat, 2020-01-03 = Fri.
    expect(screen.getByText('Sat 4 Jan')).toBeTruthy();
    expect(screen.getByText('Fri 3 Jan')).toBeTruthy();
  });
});

// ===== budgetDetailRefile (folded from budgetDetailRefile.screen.test.tsx) =====
// Integration check on the budget screen: the shared TransactionRow's trailing arrow renders per
// row and routes to /transaction/<id>. CATS reuses the module-scope survivor const;
// the rollup + charge(over) are block-scoped (differ from / shadow the survivor's).
describe('budgetDetailRefile — related-transaction details arrow', () => {
  const BUDGET = { target: 80, posted: 15, pending: 5 };

  function charge(over: Record<string, unknown>) {
    return {
      transaction_id: 't1', date: '2026-07-20', authorized_date: '2026-07-20',
      description: 'CAFE', merchant_name: 'Cafe', amount: -5,
      account_id: 'a1', account_name: 'Everyday', category: 'coffee',
      status: 'posted', type: 'purchase', counts_to_budget: true, ...over,
    };
  }

  beforeEach(() => {
    mockPush.mockClear();
    seedDetail({ budget: BUDGET, transactions: [charge({})] });
  });

  it('gives every related transaction a details arrow', async () => {
    server.seed('/budgets/coffee/transactions', [charge({ transaction_id: 't1' }), charge({ transaction_id: 't2' }), charge({ transaction_id: 't3' })]);
    await renderWithQueries(<BudgetDetail />);

    expect(screen.getAllByLabelText('View transaction details')).toHaveLength(3);
  });

  it('tapping a row arrow opens that transaction (where it can be refiled)', async () => {
    await renderWithQueries(<BudgetDetail />);

    fireEvent.press(screen.getAllByLabelText('View transaction details')[0]);

    expect(mockPush).toHaveBeenCalledWith('/transaction/t1');
  });

  it('still shows the Pending badge on a pending charge (shared row keeps it)', async () => {
    server.seed('/budgets/coffee/transactions', [charge({ status: 'pending' })]);
    await renderWithQueries(<BudgetDetail />);

    expect(screen.getByText('Pending')).toBeTruthy();
  });
});

// ===== WHIT-203 (folded from budgetDetailDelete.screen.test.tsx) =====
// Happy-path + failure tap tests for the Delete button. deleteBudget/back come from the module-scope
// superset mocks; CATS reuses the survivor const, the rollup is block-scoped.
describe('budgetDetailDelete — Delete button (WHIT-203)', () => {
  const BUDGET = { target: 100, posted: 40, pending: 10 };
  const alerts = spyOnAlert();

  beforeEach(() => {
    mockDeleteBudget.mockClear();
    mockBack.mockClear();
    mockDeleteBudget.mockResolvedValue(true);
    seedDetail({ budget: BUDGET, transactions: [], daysLeft: 12 });
  });

  // WHIT-708: Delete budget opens a confirm first; this confirms it.
  async function deleteAndConfirm() {
    fireEvent.press(screen.getByText('Delete budget'));
    expect(mockDeleteBudget).not.toHaveBeenCalled();
    await act(async () => { await pressAlertButton(alerts, 'Delete'); });
  }

  it('pressing Delete budget removes this budget once and navigates back to the Budgets tab', async () => {
    await renderWithQueries(<BudgetDetail />);

    await deleteAndConfirm();

    expect(mockDeleteBudget).toHaveBeenCalledTimes(1);
    expect(mockDeleteBudget).toHaveBeenCalledWith('coffee');
    await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
  });

  it('a failed delete stays on the screen (no navigation) so the user can retry', async () => {
    mockDeleteBudget.mockResolvedValue(false);
    await renderWithQueries(<BudgetDetail />);

    await deleteAndConfirm();

    expect(mockDeleteBudget).toHaveBeenCalledTimes(1);
    expect(mockBack).not.toHaveBeenCalled();
  });
});

// ===== WHIT-72 (folded from budgetDetailPayCycleError.screen.test.tsx) =====
// Locks the blank-on-payCycleError branch in both directions with a VALID budget present. CATS
// reuses the survivor const, the rollup is block-scoped.
describe('budgetDetailPayCycleError — blank-on-payCycleError branch (WHIT-72)', () => {
  const BUDGET = { target: 100, posted: 40, pending: 10 };

  beforeEach(() => {
    seedDetail({ budget: BUDGET, transactions: [], daysLeft: 12 });
  });

  it('payCycleError=true → the screen blanks (Header only), no detail card and no Edit (never a wrong-cycle detail)', async () => {
    server.fail('/paycycle', 500);
    await renderWithQueries(<BudgetDetail />);
    expect(screen.queryByText('Edit')).toBeNull();                  // the full detail is NOT rendered
    expect(screen.queryByText('RELATED TRANSACTIONS')).toBeNull();
    expect(screen.queryByText('Cafes & Coffee')).toBeNull();
  });

  it('payCycleError=false with a valid budget → the full detail renders (regression guard)', async () => {
    await renderWithQueries(<BudgetDetail />);
    expect(screen.getByText('Edit')).toBeTruthy();
    expect(screen.getByText('Cafes & Coffee')).toBeTruthy();
    expect(screen.getByText('RELATED TRANSACTIONS')).toBeTruthy();
  });
});

// ===== budget cafe-mismatch (folded from budgetDetailRowTargets.screen.test.tsx) =====
// GAP tests for the budget-detail Related Transactions rows after the swap to the shared
// TransactionRow. openPicker/push come from the module-scope superset mocks; CATS reuses the
// survivor const, the rollup + charge(over) are block-scoped.
describe('budgetDetailRowTargets — shared-row integration gaps', () => {
  const BUDGET = { target: 80, posted: 15, pending: 5 };

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
    seedDetail({ budget: BUDGET, transactions: [charge({})] });
  });

  // [G1] mixed pending + posted → the Pending badge is per-row (exactly one, on the pending row),
  // and the old row's always-on "Posted" status text did NOT come along with the swap.
  it('shows the Pending badge on exactly the pending row in a mixed list (no stray Posted text)', async () => {
    server.seed('/budgets/coffee/transactions', [
      charge({ transaction_id: 't1', status: 'pending' }),
      charge({ transaction_id: 't2', status: 'posted' }),
      charge({ transaction_id: 't3', status: 'posted' }),
    ]);
    await renderWithQueries(<BudgetDetail />);

    expect(screen.getAllByText('Pending')).toHaveLength(1);                       // only the pending row
    expect(screen.queryByText('Posted')).toBeNull();                             // old status text is gone
  });

  // [G2] locks the shared row's dual-target contract as this screen wires it. In prod a budget's
  // related list is filtered to its category subtree and only uncategorized rows are body-tappable,
  // so no real budget row is ever body-tappable — this feeds an uncategorized row anyway to prove the
  // wiring seam (real openPicker via context + real router): the body opens the picker for THIS id
  // AND the trailing arrow still routes to the detail page, with neither cannibalising the other.
  it('an uncategorized related row exposes both a body refile-tap and a details arrow', async () => {
    server.seed('/budgets/coffee/transactions', [charge({ transaction_id: 'tx9', category: null })]);
    await renderWithQueries(<BudgetDetail />);

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
  it('a categorized related row is body-inert and refiles only via the arrow', async () => {
    server.seed('/budgets/coffee/transactions', [charge({ transaction_id: 't1', category: 'coffee' })]);
    await renderWithQueries(<BudgetDetail />);

    // Assert "Uncategorized" is absent anywhere: an empty category lookup would make the row read
    // "Uncategorized", so its absence proves the screen passed the real taxonomy. (The header shows the
    // category name "Cafes & Coffee", not "Uncategorized", so a global absence check is safe here.)
    expect(screen.queryByText('Uncategorized')).toBeNull();
    fireEvent.press(screen.getByText('Cafe'));                   // press the row body (unique merchant)
    expect(mockOpenPicker).not.toHaveBeenCalled();               // body tap does nothing on a filed row

    fireEvent.press(screen.getByLabelText('View transaction details'));
    expect(mockPush).toHaveBeenCalledWith('/transaction/t1');    // arrow is the sole refile entry
  });
});

// ===== WHIT-730 QA: the "today" tick and its "today's plan" label hide once over budget =====
describe('WHIT-730 — today tick on the budget screen', () => {
  it("[A18] (P0) an over-budget screen draws no tick and no \"today's plan\"", async () => {
    seedDetail({ budget: { target: 80, posted: 95, pending: 0 }, transactions: [] });
    await renderWithQueries(<BudgetDetail />);
    await screen.findByText('Over budget — ease up');
    expect(screen.queryByText("today's plan")).toBeNull();
    expect(screen.UNSAFE_getByType(BudgetBar).props.showTarget).toBe(false);
  });

  it("[A19] (P1) an under-budget screen keeps the tick and \"today's plan\"", async () => {
    seedDetail({ budget: { target: 80, posted: 40, pending: 0 }, transactions: [] });
    await renderWithQueries(<BudgetDetail />);
    expect(await screen.findByText("today's plan")).toBeTruthy();
    expect(screen.UNSAFE_getByType(BudgetBar).props.showTarget).toBe(true);
  });
});
