// The budget-detail related-transactions list shows the WHOLE cycle (server-filtered to the
// subtree), paged client-side: first 7 rows, then a "Load More" button reveals the next page.
// The categories, budget rollup, the budget's cycle charges and the pay cycle come from the fake
// server through the real query hooks (WHIT-672); ../context keeps only the writers
// (deleteBudget, openPicker); expo-router stubbed.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { routerSpies, setParams, resetRouter } from './support/routerMock';
import React from 'react';
import { screen, fireEvent } from '@testing-library/react-native';

jest.mock('../context', () =>
  require('./support/contextMock').realContextWith(() => ({ deleteBudget: jest.fn(), openPicker: jest.fn() })),
);
jest.mock('../auth', () => require('./support/authMock').authMockModule());

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import BudgetDetail from '../../app/budget/[id]';
import { resetAuth } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { COFFEE as COFFEE_CATEGORY } from './support/categories';

const server = installFakeServer();
useTestQueryClient();

beforeEach(() => {
  resetRouter();
  setParams({ id: 'coffee' });
  resetAuth();
});

const CATS = [{ ...COFFEE_CATEGORY }];
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

function charge(i: number, date = '2026-07-20') {
  return {
    transaction_id: `t${i}`, date, authorized_date: date,
    description: `CAFE ${i}`, merchant_name: `Cafe ${i}`, amount: -5,
    account_id: 'a1', account_name: 'Everyday', category: 'coffee',
    status: 'posted', type: 'purchase', counts_to_budget: true,
  };
}

it('shows the first 7 rows with a Load More button, then reveals the rest on press', async () => {
  // 9 cycle charges, all one date so they form a single group rendered in list order.
  seedDetail({ budget: COFFEE, transactions: Array.from({ length: 9 }, (_, i) => charge(i + 1)) });
  await renderWithQueries(<BudgetDetail />);

  expect(screen.getAllByLabelText('View transaction details')).toHaveLength(7);
  const loadMore = screen.getByTestId('budget-load-more');

  fireEvent.press(loadMore);

  expect(screen.getAllByLabelText('View transaction details')).toHaveLength(9);
  // All revealed → the button is gone.
  expect(screen.queryByTestId('budget-load-more')).toBeNull();
});

// The 7-row page boundary falls in the MIDDLE of a date's charges — a PARTIAL second date-group,
// which only slice-then-group can produce (grouping the whole list then paging groups can't).
it('pages rows (not groups): the first page shows a PARTIAL second date-group', async () => {
  // 4 charges on the newer date, then 6 on the older date (newest-first, as the server sends).
  const dayA = [1, 2, 3, 4].map((i) => charge(i, '2020-01-04'));
  const dayB = [5, 6, 7, 8, 9, 10].map((i) => charge(i, '2020-01-03'));
  seedDetail({ budget: { target: 80, posted: 50, pending: 0 }, transactions: [...dayA, ...dayB] });
  await renderWithQueries(<BudgetDetail />);

  expect(screen.getAllByLabelText('View transaction details')).toHaveLength(7);
  expect(screen.getByText('Cafe 4')).toBeTruthy();   // last of day A
  expect(screen.getByText('Cafe 7')).toBeTruthy();   // day B, within the first page
  expect(screen.queryByText('Cafe 8')).toBeNull();   // day B, but past the 7-row cut → hidden
  expect(screen.queryByText('Cafe 10')).toBeNull();
});

it('tapping a row arrow opens that transaction (where it can be refiled)', async () => {
  seedDetail({ budget: { target: 80, posted: 15, pending: 5 }, transactions: [charge(1)] });
  await renderWithQueries(<BudgetDetail />);

  fireEvent.press(screen.getAllByLabelText('View transaction details')[0]);

  expect(routerSpies.push).toHaveBeenCalledWith('/transaction/t1');
});

// WHIT-72: with a VALID budget present, a pay-cycle error blanks the screen rather than showing
// a detail for the wrong cycle.
describe('budgetDetailPayCycleError — blank-on-payCycleError branch (WHIT-72)', () => {
  it('payCycleError=true → the screen blanks (Header only), no detail card and no Edit (never a wrong-cycle detail)', async () => {
    seedDetail({ budget: { target: 100, posted: 40, pending: 10 }, transactions: [], daysLeft: 12 });
    server.fail('/paycycle', 500);
    await renderWithQueries(<BudgetDetail />);
    expect(screen.queryByText('Edit')).toBeNull();                  // the full detail is NOT rendered
    expect(screen.queryByText('RELATED TRANSACTIONS')).toBeNull();
    expect(screen.queryByText('Cafes & Coffee')).toBeNull();
  });
});
