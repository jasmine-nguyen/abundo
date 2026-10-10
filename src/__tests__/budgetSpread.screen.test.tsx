// Bill SPREAD screens (WHIT-505): the new app/budget/spread.tsx (amount + cycle stepper +
// Save/Remove) and the entry point on app/budget/[id].tsx. Same ../context + expo-router mocking
// as budgetEditSave: keep the REAL context (spreadPreview/constants/budgetDetail run for real) and
// only override useAppContext with the writers. The categories, budget rollups, the budget's
// charges and the pay cycle come from the fake server through the real query hooks (WHIT-672).
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { routerSpies, setParams, resetRouter } from './support/routerMock';
import React from 'react';
import { screen, fireEvent, act, waitFor } from '@testing-library/react-native';

const mockSaveSpread = jest.fn(async (_id: string, _amount: number, _cycles: number) => true);
const mockRemoveSpread = jest.fn(async (_id: string) => true);


jest.mock('../context', () =>
  require('./support/contextMock').realContextWith(() => ({ saveSpread: mockSaveSpread, removeSpread: mockRemoveSpread, deleteBudget: jest.fn() })),
);
jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import BudgetSpread from '../../app/budget/spread';
import BudgetDetail from '../../app/budget/[id]';
import { resetAuth } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { COFFEE, SALARY } from './support/categories';
import { budgetRow } from './factory';

const SPEND = COFFEE;

const server = installFakeServer();
useTestQueryClient();

// The server's rollup for a plain $100 coffee budget; a spread plan rides along as `spread`, and
// `available` carries the cushion like the server's (WHIT-840).
const rollup = (over = {}) => budgetRow({ rollover: false, carryover: 0, ...over });
const activePlan = { amount: 300, cycles: 4, index: 1, adjustment: -75 };

function seedBudgets(budgets: Record<string, unknown>) {
  server.seed('/categories', [SPEND]);
  server.seed('/budgets', budgets);
}

beforeEach(() => {
  resetRouter();
  mockSaveSpread.mockReset();
  mockSaveSpread.mockImplementation(async () => true);
  mockRemoveSpread.mockClear();
  setParams({ categoryId: 'coffee' });
  resetAuth();
});

// ── the spread screen ────────────────────────────────────────────────────────
describe('app/budget/spread.tsx', () => {
  it('seeds the amount from the prefill and saves amount + default cycles once, then navigates back', async () => {
    setParams({ categoryId: 'coffee', prefill: '120' });
    seedBudgets({ coffee: rollup() });
    await renderWithQueries(<BudgetSpread />);

    expect(screen.getByTestId('spread-amount').props.value).toBe('120');    // prefilled with the overspend
    await act(async () => { fireEvent.press(screen.getByTestId('spread-save')); });

    expect(mockSaveSpread).toHaveBeenCalledTimes(1);
    expect(mockSaveSpread).toHaveBeenCalledWith('coffee', 120, 3);           // default cycle count 3
    await waitFor(() => expect(routerSpies.back).toHaveBeenCalled());
  });

  it('no budget target → shows the "set a budget first" guard, not the amount field (WHIT-556)', async () => {
    // A spend category with NO budget row (e.g. a list-render→navigate race, or the tx-screen
    // entry landing before a target exists). A save would 400, so the screen guides instead.
    setParams({ categoryId: 'coffee', prefill: '120' });
    seedBudgets({});
    await renderWithQueries(<BudgetSpread />);

    expect(screen.getByTestId('spread-no-budget')).toBeTruthy();
    expect(screen.getByText('Set a budget for this category before spreading a bill.')).toBeTruthy();
    expect(screen.queryByTestId('spread-amount')).toBeNull();   // no doomed save path
    expect(screen.queryByTestId('spread-save')).toBeNull();
  });

  it('the cycle stepper changes how many cycles the bill spreads over', async () => {
    setParams({ categoryId: 'coffee', prefill: '120' });
    seedBudgets({ coffee: rollup() });
    await renderWithQueries(<BudgetSpread />);

    fireEvent.press(screen.getByTestId('spread-cycles-plus'));               // 3 → 4
    await act(async () => { fireEvent.press(screen.getByTestId('spread-save')); });

    expect(mockSaveSpread).toHaveBeenCalledWith('coffee', 120, 4);
  });

  it('an amount of 0 keeps Save disabled (no write)', async () => {
    setParams({ categoryId: 'coffee' });  // no prefill → empty amount
    seedBudgets({ coffee: rollup() });
    await renderWithQueries(<BudgetSpread />);

    await act(async () => { fireEvent.press(screen.getByTestId('spread-save')); });

    expect(mockSaveSpread).not.toHaveBeenCalled();
  });

  it('an active plan seeds its amount, shows Remove, and Remove calls removeSpread once', async () => {
    setParams({ categoryId: 'coffee' });
    seedBudgets({ coffee: rollup({ spread: activePlan }) });
    await renderWithQueries(<BudgetSpread />);

    expect(screen.getByTestId('spread-amount').props.value).toBe('300');     // seeded from the active plan
    await act(async () => { fireEvent.press(screen.getByTestId('spread-remove')); });

    expect(mockRemoveSpread).toHaveBeenCalledTimes(1);
    expect(mockRemoveSpread).toHaveBeenCalledWith('coffee');
    await waitFor(() => expect(routerSpies.back).toHaveBeenCalled());
  });

  it('the amount field keeps only a single decimal point (shown matches saved)', async () => {
    // FAIL-ON-REVERT for cleanAmount: a second dot in "5.5.5" would otherwise display but the
    // parsed/saved value would be 5.5 — the field must collapse it so shown === saved.
    setParams({ categoryId: 'coffee' });
    seedBudgets({ coffee: rollup() });
    await renderWithQueries(<BudgetSpread />);

    // "5.5.5" collapses the stray second dot (digits kept) → "5.55", which is exactly what
    // parseFloat saves, so the shown value and the saved value agree.
    fireEvent.changeText(screen.getByTestId('spread-amount'), '5.5.5');
    expect(screen.getByTestId('spread-amount').props.value).toBe('5.55');
    await act(async () => { fireEvent.press(screen.getByTestId('spread-save')); });
    expect(mockSaveSpread).toHaveBeenCalledWith('coffee', 5.55, 3);
  });

  // The value never drops below 1, and minus disables at the floor.
  it('[G10] the minus button disables at 1 cycle and never steps below', async () => {
    setParams({ categoryId: 'coffee', prefill: '120' });
    seedBudgets({ coffee: rollup() });
    await renderWithQueries(<BudgetSpread />);

    const minus = () => screen.getByTestId('spread-cycles-minus');
    expect(minus().props.accessibilityState?.disabled).toBeFalsy();      // enabled at default 3
    fireEvent.press(minus());   // 3 → 2
    fireEvent.press(minus());   // 2 → 1
    expect(screen.getByText('1')).toBeTruthy();
    expect(minus().props.accessibilityState?.disabled).toBe(true);       // floor reached
    fireEvent.press(minus());   // blocked
    expect(screen.getByText('1')).toBeTruthy();                          // still 1
    await act(async () => { fireEvent.press(screen.getByTestId('spread-save')); });
    expect(mockSaveSpread).toHaveBeenCalledWith('coffee', 120, 1);
  });

  // A failed save must not navigate back and must re-enable the button so the user can retry.
  it('[G12] saveSpread → false leaves the screen mounted and re-enabled for retry', async () => {
    setParams({ categoryId: 'coffee', prefill: '120' });
    mockSaveSpread.mockImplementation(async () => false);
    seedBudgets({ coffee: rollup() });
    await renderWithQueries(<BudgetSpread />);

    await act(async () => { fireEvent.press(screen.getByTestId('spread-save')); });
    expect(mockSaveSpread).toHaveBeenCalledTimes(1);
    expect(routerSpies.back).not.toHaveBeenCalled();                     // stayed on the screen

    await act(async () => { fireEvent.press(screen.getByTestId('spread-save')); });
    expect(mockSaveSpread).toHaveBeenCalledTimes(2);                     // re-enabled → retried
    expect(routerSpies.back).not.toHaveBeenCalled();
  });

  // Both presses land before the pending save resolves: the writer fires exactly once.
  it('[G13] a double-tap while the save is in flight fires the writer once', async () => {
    setParams({ categoryId: 'coffee', prefill: '120' });
    let resolveSave: (v: boolean) => void = () => {};
    mockSaveSpread.mockImplementation(() => new Promise<boolean>((res) => { resolveSave = res; }));
    seedBudgets({ coffee: rollup() });
    await renderWithQueries(<BudgetSpread />);

    await act(async () => {
      fireEvent.press(screen.getByTestId('spread-save'));
      fireEvent.press(screen.getByTestId('spread-save'));   // same frame, save still pending
    });
    expect(mockSaveSpread).toHaveBeenCalledTimes(1);
    await act(async () => { resolveSave(true); });
    await waitFor(() => expect(routerSpies.back).toHaveBeenCalledTimes(1));
  });

  // A spread is spend-only; the server would reject it for an Income category.
  it('[G14] an Income category shows the note, not the amount form', async () => {
    setParams({ categoryId: 'salary' });
    server.seed('/categories', [SALARY]);
    server.seed('/budgets', {});
    await renderWithQueries(<BudgetSpread />);

    expect(screen.getByText('Only spend categories can spread a bill.')).toBeTruthy();
    expect(screen.queryByTestId('spread-amount')).toBeNull();
    expect(screen.queryByTestId('spread-save')).toBeNull();
  });

  it('[G15] an undefined categoryId renders the header only, no form, no crash', async () => {
    setParams({} as { categoryId?: string });
    seedBudgets({});
    await expect(renderWithQueries(<BudgetSpread />)).resolves.toBeDefined();
    expect(screen.queryByTestId('spread-amount')).toBeNull();
    expect(screen.queryByTestId('spread-save')).toBeNull();
  });
});

// ── the entry point on the detail screen ─────────────────────────────────────
describe('app/budget/[id].tsx — spread entry point', () => {
  // A fortnight cycle with 7 days left (the server's own countdown), and no charges listed.
  function seedDetail(over = {}) {
    seedBudgets({ coffee: rollup(over) });
    server.seed('/budgets/coffee/transactions', []);
    server.seed('/paycycle', { length: 14, last_pay_date: '2026-06-06', days_left: 7 });
  }

  it('over budget with no plan → "Spread this bill", not the edit label', async () => {
    setParams({ id: 'coffee' });
    // posted 130 > budget 100 → over, no plan.
    seedDetail({ posted: 130 });
    await renderWithQueries(<BudgetDetail />);

    expect(screen.getByText('Spread this bill over pay cycles')).toBeTruthy();
    expect(screen.queryByText('Edit or remove bill spread')).toBeNull();
  });

  it('an active plan → "Edit or remove bill spread" stays reachable even when the cushion clears over', async () => {
    setParams({ id: 'coffee' });
    // cushion makes spent < available, so `over` is false — the entry must key off the plan, not over.
    seedDetail({ posted: 250, spread: { amount: 300, cycles: 4, index: 0, adjustment: 300 } });
    await renderWithQueries(<BudgetDetail />);

    expect(screen.getByText('Edit or remove bill spread')).toBeTruthy();
    expect(screen.queryByText('Spread this bill over pay cycles')).toBeNull();
  });
});
