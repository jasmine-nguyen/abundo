// The budget-detail related-transactions list now shows the WHOLE cycle (server-filtered
// to the subtree), paged client-side: first 7 rows, then a "Load More" button reveals the
// next page. Locks that the list is not truncated to a fixed slice and Load More works.
// ../queries re-routed via the shared screenQueryMocks harness; ../context real (budgetDetail
// + transactionView stay pure); expo-router stubbed.
// WHIT-459: budgetDetailRefile / budgetDetailDelete / budgetDetailPayCycleError /
// budgetDetailRowTargets are folded in as child describes at the END of this file. All five
// share the same ../queries + ../context + expo-router mocks; the factories are reconciled to a
// SUPERSET here (module-scope mock fns below) and each folded block re-seeds mockState in its own
// beforeEach. Every it body is preserved byte-for-byte.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react-native';
import type { ScreenState } from './support/screenQueryMocks';

// Superset of the folded files' router/context handles: the delete block asserts back() + the
// writer, refile/rowTargets assert push(), rowTargets asserts openPicker(). Each is hoistable
// into the jest.mock factories (name starts with `mock`) and read lazily at render time; every
// folded block clears + asserts only the ones it needs (clearMocks:true also zeroes call records).
const mockPush = jest.fn();
const mockBack = jest.fn();
const mockDeleteBudget = jest.fn(async (_id: string) => true);
const mockOpenPicker = jest.fn();

let mockState: ScreenState;
jest.mock('../queries', () => require('./support/screenQueryMocks').queryMocksFromState(() => mockState));

jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ deleteBudget: mockDeleteBudget, openPicker: mockOpenPicker }) };
});

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: mockBack }),
  useLocalSearchParams: () => ({ id: 'coffee' }),
}));

import BudgetDetail from '../../app/budget/[id]';

const CATS = [{ id: 'coffee', name: 'Cafes & Coffee', bucket: 'Lifestyle', icon: 'coffee', color: '#E8A87C', recent: 0 }];
const BUDGETS = [{ id: 'coffee', budget: 80, posted: 52, pending: 0 }];

// 9 cycle charges, all one date so they form a single group rendered in list order.
function nCharges(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    transaction_id: `t${i + 1}`, date: '2026-07-20', authorized_date: '2026-07-20',
    description: `CAFE ${i + 1}`, merchant_name: `Cafe ${i + 1}`, amount: -5,
    account_id: 'a1', account_name: 'Everyday', category: 'coffee',
    status: 'posted', type: 'purchase', counts_to_budget: true,
  }));
}

beforeEach(() => {
  mockState = { categories: CATS, budgets: BUDGETS, transactions: nCharges(9), cycleLen: 30, daysLeft: 5, payCycleError: false };
});

it('shows the first 7 rows with a Load More button, then reveals the rest on press', () => {
  render(<BudgetDetail />);

  expect(screen.getAllByLabelText('View transaction details')).toHaveLength(7);
  const loadMore = screen.getByTestId('budget-load-more');

  fireEvent.press(loadMore);

  expect(screen.getAllByLabelText('View transaction details')).toHaveLength(9);
  // All revealed → the button is gone.
  expect(screen.queryByTestId('budget-load-more')).toBeNull();
});

it('shows no Load More button when the cycle has 7 or fewer charges', () => {
  mockState = { ...mockState, transactions: nCharges(7) };
  render(<BudgetDetail />);

  expect(screen.getAllByLabelText('View transaction details')).toHaveLength(7);
  expect(screen.queryByTestId('budget-load-more')).toBeNull();
});

it('shows the empty copy when the budget has no charges this cycle', () => {
  mockState = { ...mockState, transactions: [] };
  render(<BudgetDetail />);

  expect(screen.queryByLabelText('View transaction details')).toBeNull();
  expect(screen.getByText('No transactions in this category this cycle.')).toBeTruthy();
});

// ===== QA gap (folded in): Load More across a DATE BOUNDARY =====
// The tests above put all 9 charges on ONE date (a single group), so they can't catch a regression
// where the screen groups the WHOLE list then pages groups, instead of paging ROWS then grouping
// the slice. Here the 7-row page boundary falls in the MIDDLE of a date's charges — a PARTIAL
// second date-group, which only slice-then-group can produce. Own beforeEach: a two-date fixture.
const BUDGETS_BOUNDARY = [{ id: 'coffee', budget: 80, posted: 50, pending: 0 }];

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
    mockState = { categories: CATS, budgets: BUDGETS_BOUNDARY, transactions: twoDayCharges(), cycleLen: 30, daysLeft: 5, payCycleError: false };
  });

  // [A-loadmore-boundary] the first page is 7 ROWS spanning both dates — the older date-group is
  // shown PARTIALLY (Cafe 5-7 visible, Cafe 8-10 hidden). Grouping the whole list then paging
  // groups could never show a partial group.
  it('pages rows (not groups): the first page shows a PARTIAL second date-group', () => {
    render(<BudgetDetail />);

    expect(screen.getAllByLabelText('View transaction details')).toHaveLength(7);
    expect(screen.getByText('Cafe 4')).toBeTruthy();   // last of day A
    expect(screen.getByText('Cafe 7')).toBeTruthy();   // day B, within the first page
    expect(screen.queryByText('Cafe 8')).toBeNull();   // day B, but past the 7-row cut → hidden
    expect(screen.queryByText('Cafe 10')).toBeNull();
  });

  // [A-loadmore-boundary-reveal] Load More reveals the rest of the older date's group; the button
  // then disappears (all 10 revealed).
  it('Load More reveals the rest of the split date-group, then hides the button', () => {
    render(<BudgetDetail />);
    fireEvent.press(screen.getByTestId('budget-load-more'));

    expect(screen.getAllByLabelText('View transaction details')).toHaveLength(10);
    expect(screen.getByText('Cafe 8')).toBeTruthy();
    expect(screen.getByText('Cafe 10')).toBeTruthy();
    expect(screen.queryByTestId('budget-load-more')).toBeNull();
  });

  // [A-loadmore-two-groups] the first page renders BOTH date headings (the slice crosses the
  // boundary), proving the slice is grouped — not just row-capped within one group.
  it('renders both date-group headings on the first page (slice is grouped by date)', () => {
    render(<BudgetDetail />);
    // dateLabel formats a far-past date as "<weekday> <d> <mon>": 2020-01-04 = Sat, 2020-01-03 = Fri.
    expect(screen.getByText('Sat 4 Jan')).toBeTruthy();
    expect(screen.getByText('Fri 3 Jan')).toBeTruthy();
  });
});

// ===== budgetDetailRefile (folded from budgetDetailRefile.screen.test.tsx) =====
// Integration check on the budget screen: the shared TransactionRow's trailing arrow renders per
// row and routes to /transaction/<id>. CATS reuses the module-scope survivor const (byte-identical);
// BUDGETS + charge(over) are block-scoped (differ from / shadow the survivor's).
describe('budgetDetailRefile — related-transaction details arrow', () => {
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
    mockPush.mockClear();
    mockState = { categories: CATS, budgets: BUDGETS, transactions: [charge({})], cycleLen: 30, daysLeft: 5, payCycleError: false };
  });

  it('gives every related transaction a details arrow', () => {
    mockState = { ...mockState, transactions: [charge({ transaction_id: 't1' }), charge({ transaction_id: 't2' }), charge({ transaction_id: 't3' })] };
    render(<BudgetDetail />);

    expect(screen.getAllByLabelText('View transaction details')).toHaveLength(3);
  });

  it('tapping a row arrow opens that transaction (where it can be refiled)', () => {
    render(<BudgetDetail />);

    fireEvent.press(screen.getAllByLabelText('View transaction details')[0]);

    expect(mockPush).toHaveBeenCalledWith('/transaction/t1');
  });

  it('still shows the Pending badge on a pending charge (shared row keeps it)', () => {
    mockState = { ...mockState, transactions: [charge({ status: 'pending' })] };
    render(<BudgetDetail />);

    expect(screen.getByText('Pending')).toBeTruthy();
  });
});

// ===== WHIT-203 (folded from budgetDetailDelete.screen.test.tsx) =====
// Happy-path + failure tap tests for the Delete button. deleteBudget/back come from the module-scope
// superset mocks; CATS reuses the survivor const, BUDGETS is block-scoped.
describe('budgetDetailDelete — Delete button (WHIT-203)', () => {
  const BUDGETS = [{ id: 'coffee', budget: 100, posted: 40, pending: 10 }];

  beforeEach(() => {
    mockDeleteBudget.mockClear();
    mockBack.mockClear();
    mockDeleteBudget.mockResolvedValue(true);
    mockState = { categories: CATS, budgets: BUDGETS, transactions: [], cycleLen: 30, daysLeft: 12, payCycleError: false };
  });

  it('pressing Delete budget removes this budget once and navigates back to the Budgets tab', async () => {
    render(<BudgetDetail />);

    await act(async () => { fireEvent.press(screen.getByText('Delete budget')); });

    expect(mockDeleteBudget).toHaveBeenCalledTimes(1);
    expect(mockDeleteBudget).toHaveBeenCalledWith('coffee');
    await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
  });

  it('a failed delete stays on the screen (no navigation) so the user can retry', async () => {
    mockDeleteBudget.mockResolvedValue(false);
    render(<BudgetDetail />);

    await act(async () => { fireEvent.press(screen.getByText('Delete budget')); });

    expect(mockDeleteBudget).toHaveBeenCalledTimes(1);
    expect(mockBack).not.toHaveBeenCalled();
  });
});

// ===== WHIT-72 (folded from budgetDetailPayCycleError.screen.test.tsx) =====
// Locks the blank-on-payCycleError branch in both directions with a VALID budget present. CATS
// reuses the survivor const, BUDGETS is block-scoped.
describe('budgetDetailPayCycleError — blank-on-payCycleError branch (WHIT-72)', () => {
  const BUDGETS = [{ id: 'coffee', budget: 100, posted: 40, pending: 10 }];

  beforeEach(() => {
    mockState = { categories: CATS, budgets: BUDGETS, transactions: [], cycleLen: 30, daysLeft: 12, payCycleError: false };
  });

  it('payCycleError=true → the screen blanks (Header only), no detail card and no Edit (never a wrong-cycle detail)', () => {
    mockState = { ...mockState, payCycleError: true };
    render(<BudgetDetail />);
    expect(screen.queryByText('Edit')).toBeNull();                  // the full detail is NOT rendered
    expect(screen.queryByText('RELATED TRANSACTIONS')).toBeNull();
    expect(screen.queryByText('Cafes & Coffee')).toBeNull();
  });

  it('payCycleError=false with a valid budget → the full detail renders (regression guard)', () => {
    render(<BudgetDetail />);
    expect(screen.getByText('Edit')).toBeTruthy();
    expect(screen.getByText('Cafes & Coffee')).toBeTruthy();
    expect(screen.getByText('RELATED TRANSACTIONS')).toBeTruthy();
  });
});

// ===== budget cafe-mismatch (folded from budgetDetailRowTargets.screen.test.tsx) =====
// GAP tests for the budget-detail Related Transactions rows after the swap to the shared
// TransactionRow. openPicker/push come from the module-scope superset mocks; CATS reuses the
// survivor const, BUDGETS + charge(over) are block-scoped.
describe('budgetDetailRowTargets — shared-row integration gaps', () => {
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
});
