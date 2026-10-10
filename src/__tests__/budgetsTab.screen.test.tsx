// The Budgets tab and the budget detail screen. The real screens and ../queries run over the fake
// server; ../auth and expo-router use the shared mocks, ../context is the real one with the
// delete/picker actions stubbed, and large text is off unless a describe turns it on.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { screen, fireEvent, waitFor, within } from '@testing-library/react-native';
import type { ReactTestInstance } from 'react-test-renderer';
import { routerSpies, resetRouter, setParams } from './support/routerMock';
import { resetAuth } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { budgetRow } from './factory';
import { seedBudgets, renderBudgets, renderLoadedBudgets, heroTotals, renderLoadedBudgetsWithQueries, BUDGET_PAY_CYCLE, showTwoRows, showRows } from './support/budgetsScreen';
import { refreshInAct, renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { COFFEE, GROCERIES, GROCERIES_RECORD, SALARY, SAVINGS, MORTGAGE_RECORD } from './support/categories';
import { seedBudgetsTab } from './support/budgetsTab';
import { styleOf, sharedHost } from './support/layout';
import { pullAndSettle } from './support/pull';
import { BudgetBar } from '../components/ui';

let mockLarge = false;
jest.mock('../hooks/useLargeText', () =>
  require('./support/largeTextMock').largeTextMockModule(() => mockLarge));
jest.mock('../context', () => require('./support/budgetsSuite').budgetsContextMockModule());
jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import BudgetDetail from '../../app/budget/[id]';

const server = installFakeServer();
useTestQueryClient();

beforeEach(() => {
  mockLarge = false;
  resetRouter();
  resetAuth();
});

describe('WHIT-706 Budgets top card', () => {
  beforeEach(() => {
    seedBudgets(server, { payCycle: { length: 30, last_pay_date: '2026-07-01', days_left: 4 } });
  });

  it('no budgets → days left stays, money part is replaced by one "Add a spending budget" button', async () => {
    server.seed('/budgets', {});
    renderBudgets();
    expect(await screen.findByText('Add a spending budget')).toBeTruthy();
    expect(screen.getByText("No spending budgets yet. Set one and this shows what's left to spend.")).toBeTruthy();
    expect(screen.getByText('days left')).toBeTruthy();
    expect(screen.queryByText('Budget remaining')).toBeNull();
    expect(screen.queryByText('Left to spend')).toBeNull();
    expect(screen.queryByText('Over budget')).toBeNull();
    expect(screen.queryByTestId('budgets-hero-spent')).toBeNull();
    expect(screen.queryByText('Add a budget')).toBeNull();  // the duplicate dashed button is hidden
    fireEvent.press(screen.getByTestId('budgets-hero-add'));
    expect(routerSpies.push).toHaveBeenCalledWith('/budget/pick');
  });

  it('[A1] under budget shows the left-to-spend amount (summed across rows) and the spent line', async () => {
    server.seed('/categories', [COFFEE, GROCERIES]);
    server.seed('/budgets', {
      coffee: { target: 100, posted: 40, pending: 10 },
      groceries: { target: 250, posted: 40, pending: 0 },
    });
    await renderLoadedBudgets();
    expect(screen.getByText('$260')).toBeTruthy();
    expect(screen.getByText('Left to spend')).toBeTruthy();
    expect(heroTotals()).toMatchObject({ spent: '$90', budget: '$350' });
    expect(screen.getByText('4')).toBeTruthy();
  });

  it('[A4] empty → a budget appears on refetch → money view returns, first-time prompt goes', async () => {
    server.seed('/budgets', {});
    const { client } = renderBudgets();
    await screen.findByText('Add a spending budget');
    server.seed('/budgets', { coffee: { target: 100, posted: 40, pending: 10 } });
    await refreshInAct(() => client.invalidateQueries({ queryKey: ['budgets'] }));
    expect(await screen.findByText('Cafes & Coffee')).toBeTruthy();
    expect(screen.queryByText('Add a spending budget')).toBeNull();
    expect(screen.getByText('Left to spend')).toBeTruthy();
    expect(screen.queryByText('Add a budget')).toBeNull(); // WHIT-814: no dashed row; the header "+" adds
  });

  // Unparseable last_pay_date → no payday line, never "NaN" / "undefined".
  it('[A7] an unparseable last_pay_date hides the next payday line', async () => {
    server.seed('/paycycle', { length: 30, last_pay_date: 'garbage', days_left: 4 });
    await renderLoadedBudgets();
    expect(screen.queryByTestId('budgets-hero-payday')).toBeNull();
    expect(screen.queryByText('Next payday')).toBeNull();
    expect(screen.queryByText(/NaN|undefined/)).toBeNull();
  });

  it('[A7] card left matches the rows: $26.50 + $39.75 = $66.25', async () => {
    seedBudgets(server, {
      budgets: {
        coffee: { target: 100, posted: 70, pending: 3.5 },
        groceries: { target: 50, posted: 10.25, pending: 0 },
      },
      categories: [COFFEE, GROCERIES],
      payCycle: { ...BUDGET_PAY_CYCLE, days_left: 4 },
    });
    await renderLoadedBudgets();
    expect(screen.getByText('$26.50')).toBeTruthy();
    expect(screen.getByText('$39.75')).toBeTruthy();
    expect(screen.getByText('$66.25')).toBeTruthy();
  });
});

it('[A25] the row press opens the detail', async () => {
  seedBudgetsTab(server, { coffee: { target: 80, posted: 90.25, pending: 0 } }, [COFFEE], 6, '2026-09-25');
  await renderLoadedBudgetsWithQueries();
  fireEvent.press(screen.getByText('Cafes & Coffee'));
  expect(routerSpies.push).toHaveBeenCalledWith('/budget/coffee');
});

describe('WHIT-714 top card totals', () => {
  // WHIT-714 — the Budgets top card must tell the truth when there are no spending budgets
  // (income-only, Savings-only) and while budgets are still loading.
  const NO_SPENDING = /^No spending budgets yet/;

  beforeEach(() => {
    seedBudgets(server, { categories: [COFFEE, SALARY, SAVINGS], payCycle: { ...BUDGET_PAY_CYCLE, days_left: 4 } });
  });

  it('income-only budgets → no "$0 Left to spend" money column, honest empty wording', async () => {
    server.seed('/budgets', { salary: { target: 5000, posted: 1000, pending: 0 } });
    renderBudgets();
    await screen.findByText('Salary');
    expect(screen.queryByText('Left to spend')).toBeNull();
    expect(screen.queryByTestId('budgets-hero-spent')).toBeNull();
    expect(screen.getByText(NO_SPENDING)).toBeTruthy();
    expect(screen.queryByTestId('budgets-hero-add')).toBeNull();
    expect(screen.queryByText('Add a budget')).toBeNull(); // WHIT-814: the header "+" is the one add button
    expect(screen.getByText('4')).toBeTruthy();
    expect(screen.getByText('days left')).toBeTruthy();
  });

  it('while the pay cycle is still loading → spinner only, never the default cycle count', async () => {
    const heldPayCycle = server.hold('/paycycle');
    const heldBudgets = server.hold('/budgets');
    renderBudgets();
    await waitFor(() => expect(server.sent('GET', '/categories')).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByTestId('budgets-loading')).toBeTruthy();
    expect(screen.queryByText(/days? left/)).toBeNull();
    heldPayCycle.release();
    heldBudgets.release();
    expect(await screen.findByText('Cafes & Coffee')).toBeTruthy();
  });

  // Budgets loaded but categories still loading → days-only card + spinner, never the
  // "No spending budgets yet" prompt (rows are empty only because categories haven't arrived).
  it('[A3] categories still loading → days-only card, no false empty prompt', async () => {
    server.seed('/budgets', { coffee: { target: 100, posted: 40, pending: 10 } });
    const held = server.hold('/categories');
    renderBudgets();
    expect(await screen.findByText('days left')).toBeTruthy();
    expect(screen.getByText('4')).toBeTruthy();
    expect(screen.getByTestId('budgets-loading')).toBeTruthy();
    expect(screen.queryByText(NO_SPENDING)).toBeNull();
    expect(screen.queryByTestId('budgets-hero-add')).toBeNull();
    held.release();
    expect(await screen.findByText('Cafes & Coffee')).toBeTruthy();
  });

  // Pay cycle fails while budgets are still loading → error card, never a days card from the default cycle.
  it('[A4] pay cycle fails while budgets load → error view, no days-left card', async () => {
    server.fail('/paycycle', 500);
    server.hold('/budgets');
    renderBudgets();
    expect(await screen.findByTestId('budgets-error')).toBeTruthy();
    expect(screen.queryByText(/days? left/)).toBeNull();
    expect(screen.queryByTestId('budgets-loading')).toBeNull();
  });
});

// WHIT-730 — a budget with nothing spent yet draws as a slim row: no bar, but it keeps its muted
// note and still opens the budget. A budget with spending keeps its full card and bar.
it('a $0 budget is a slim row with no bar that keeps its note and still opens the budget', async () => {
  await showRows(server, {
    // Nothing spent; a spread cushion makes this cycle's budget $300 and adds the note.
    coffee: budgetRow({ target: 100, posted: 0, pending: 0, spread: { amount: 600, cycles: 3, index: 0, adjustment: 200 } }),
    groceries: { target: 100, posted: 30, pending: 0 },
  });

  expect(screen.UNSAFE_queryAllByType(BudgetBar)).toHaveLength(1);
  expect(screen.getByTestId('budget-row-note-coffee').props.children).toBe('Includes spread bills');

  fireEvent.press(screen.getByText('Cafes & Coffee'));
  expect(routerSpies.push).toHaveBeenCalledWith('/budget/coffee');
});

// WHIT-742 — the budget detail page lists the cycles behind a rollover's carryover under the note,
// with settling and estimated cycles tagged.
it('the detail page lists each cycle under the carryover note, tagging settling and estimated ones', async () => {
  setParams({ id: 'coffee' });
  seedBudgetsTab(server, {
    coffee: {
      target: 200, posted: 100, pending: 0, rollover: true, carryover: -879, available: -679,
      carryover_cycles: [
        { start: '2026-09-12', end: '2026-09-25', target: 200, spent: 720, leftover: -520, settling: true },
        { start: '2026-08-29', end: '2026-09-11', target: 200, spent: 539, leftover: -339, settling: false, rebuilt: true },
      ],
      carryover_earlier: -20,
    },
  });
  server.seed('/budgets/coffee/transactions', []);
  await renderWithQueries(<BudgetDetail />);

  await screen.findByText('Includes $879 past overspend');
  const first = within(screen.getByTestId('carryover-cycle-0'));
  expect(first.getByText(/12 Sep – 25 Sep/)).toBeTruthy();
  expect(first.getByText(/settling/)).toBeTruthy();
  expect(first.queryByText(/estimated/)).toBeNull();
  expect(first.getByText('−$520')).toBeTruthy();

  const second = within(screen.getByTestId('carryover-cycle-1'));
  expect(second.getByText(/estimated/)).toBeTruthy();
  expect(second.queryByText(/settling/)).toBeNull();
  expect(second.getByText('−$339')).toBeTruthy();

  const gap = within(screen.getByTestId('carryover-cycle-2'));
  expect(gap.getByText(/Not matched to a cycle/)).toBeTruthy();
  expect(gap.getByText('−$20')).toBeTruthy();
});

// WHIT-743 — at very large text a row stacks instead of squeezing, so no word splits mid-word.
it('a budget row stacks: the amount sits below the name, not squeezed beside it', async () => {
  mockLarge = true;
  await showTwoRows(server);
  const row = within(screen.getByTestId('budget-row-coffee'));
  const name = row.getByText('Cafes & Coffee');
  const remain = row.getByText('$20');

  expect(styleOf(sharedHost(name, remain)).flexDirection).not.toBe('row');
  for (let host: ReactTestInstance | null = remain.parent; host; host = host.parent) {
    if (typeof host.type === 'string') expect(styleOf(host).maxWidth).not.toBe('45%');
  }
});

// WHIT-745 on screen: only an over-budget row moves up. A fully used (behind-pace) Mortgage keeps its
// category place below Coffee, and the Budgets tab sends no charge-list lookups.
it('lifts only the over-budget row; a fully used mortgage keeps its place and no charge lists are fetched, even after a pull-to-refresh', async () => {
  const rowOrder = () =>
    screen.getAllByTestId(/^budget-row-(mortgage|coffee|groceries)$/).map((r) => r.props.testID);
  // Halfway through a 14-day cycle: Coffee on pace, Mortgage fully used (behind pace), Groceries over.
  seedBudgetsTab(
    server,
    {
      coffee: { target: 100, posted: 40, pending: 0 },
      mortgage: { target: 3667, posted: 3667, pending: 0 },
      groceries: { target: 100, posted: 150, pending: 0 },
    },
    [COFFEE, MORTGAGE_RECORD, GROCERIES_RECORD],
  );
  await renderLoadedBudgetsWithQueries();
  await waitFor(() =>
    expect(rowOrder()).toEqual(['budget-row-groceries', 'budget-row-coffee', 'budget-row-mortgage']),
  );
  await pullAndSettle();
  expect(rowOrder()).toEqual(['budget-row-groceries', 'budget-row-coffee', 'budget-row-mortgage']);
  expect(server.sentUnder('GET', '/budgets/')).toEqual([]);
});
