// The budget-detail related-transactions list now shows the WHOLE cycle (server-filtered
// to the subtree), paged client-side: first 7 rows, then a "Load More" button reveals the
// next page. Locks that the list is not truncated to a fixed slice and Load More works.
// ../queries re-routed via the shared screenQueryMocks harness; ../context real (budgetDetail
// + transactionView stay pure); expo-router stubbed.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import type { ScreenState } from './support/screenQueryMocks';

let mockState: ScreenState;
jest.mock('../queries', () => require('./support/screenQueryMocks').queryMocksFromState(() => mockState));

jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ deleteBudget: jest.fn(), openPicker: jest.fn() }) };
});

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
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
