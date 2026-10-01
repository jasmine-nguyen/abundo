// Bill SPREAD screens (WHIT-505): the new app/budget/spread.tsx (amount + cycle stepper +
// Save/Remove) and the entry point on app/budget/[id].tsx. Same ../context + expo-router mocking
// as budgetEditSave: keep the REAL context (spreadPreview/constants/budgetDetail run for real) and
// only override useAppContext with the writers. The categories, budget rollups, the budget's
// charges and the pay cycle come from the fake server through the real query hooks (WHIT-672).
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { screen, fireEvent, act, waitFor } from '@testing-library/react-native';

const mockSaveSpread = jest.fn(async (_id: string, _amount: number, _cycles: number) => true);
const mockRemoveSpread = jest.fn(async (_id: string) => true);
const mockBack = jest.fn();

const SPEND = { id: 'coffee', name: 'Cafes & Coffee', icon: 'coffee', color: '#E8A87C', bucket: 'Lifestyle', recent: 52 };
let mockParams: { categoryId?: string; prefill?: string; id?: string } = { categoryId: 'coffee' };

jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return {
    ...actual,
    useAppContext: () => ({ saveSpread: mockSaveSpread, removeSpread: mockRemoveSpread, deleteBudget: jest.fn() }),
  };
});
jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: mockBack, dismissAll: jest.fn() }),
  useLocalSearchParams: () => mockParams,
}));

import BudgetSpread from '../../app/budget/spread';
import BudgetDetail from '../../app/budget/[id]';
import { resetAuth } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';

const server = installFakeServer();
useTestQueryClient();

// The server's rollup for a plain $100 coffee budget; a spread plan rides along as `spread`.
const rollup = (over = {}) => ({ target: 100, posted: 0, pending: 0, rollover: false, carryover: 0, ...over });
const activePlan = { amount: 300, cycles: 4, index: 1, adjustment: -75 };

function seedBudgets(budgets: Record<string, unknown>) {
  server.seed('/categories', [SPEND]);
  server.seed('/budgets', budgets);
}

beforeEach(() => {
  mockSaveSpread.mockClear();
  mockRemoveSpread.mockClear();
  mockBack.mockClear();
  mockParams = { categoryId: 'coffee' };
  resetAuth();
});

// ── the spread screen ────────────────────────────────────────────────────────
describe('app/budget/spread.tsx', () => {
  it('seeds the amount from the prefill and saves amount + default cycles once, then navigates back', async () => {
    mockParams = { categoryId: 'coffee', prefill: '120' };
    seedBudgets({ coffee: rollup() });
    await renderWithQueries(<BudgetSpread />);

    expect(screen.getByTestId('spread-amount').props.value).toBe('120');    // prefilled with the overspend
    await act(async () => { fireEvent.press(screen.getByTestId('spread-save')); });

    expect(mockSaveSpread).toHaveBeenCalledTimes(1);
    expect(mockSaveSpread).toHaveBeenCalledWith('coffee', 120, 3);           // default cycle count 3
    await waitFor(() => expect(mockBack).toHaveBeenCalled());
  });

  it('no budget target → shows the "set a budget first" guard, not the amount field (WHIT-556)', async () => {
    // A spend category with NO budget row (e.g. a list-render→navigate race, or the tx-screen
    // entry landing before a target exists). A save would 400, so the screen guides instead.
    mockParams = { categoryId: 'coffee', prefill: '120' };
    seedBudgets({});
    await renderWithQueries(<BudgetSpread />);

    expect(screen.getByTestId('spread-no-budget')).toBeTruthy();
    expect(screen.getByText('Set a budget for this category before spreading a bill.')).toBeTruthy();
    expect(screen.queryByTestId('spread-amount')).toBeNull();   // no doomed save path
    expect(screen.queryByTestId('spread-save')).toBeNull();
  });

  it('the cycle stepper changes how many cycles the bill spreads over', async () => {
    mockParams = { categoryId: 'coffee', prefill: '120' };
    seedBudgets({ coffee: rollup() });
    await renderWithQueries(<BudgetSpread />);

    fireEvent.press(screen.getByTestId('spread-cycles-plus'));               // 3 → 4
    await act(async () => { fireEvent.press(screen.getByTestId('spread-save')); });

    expect(mockSaveSpread).toHaveBeenCalledWith('coffee', 120, 4);
  });

  it('an amount of 0 keeps Save disabled (no write)', async () => {
    mockParams = { categoryId: 'coffee' };  // no prefill → empty amount
    seedBudgets({ coffee: rollup() });
    await renderWithQueries(<BudgetSpread />);

    await act(async () => { fireEvent.press(screen.getByTestId('spread-save')); });

    expect(mockSaveSpread).not.toHaveBeenCalled();
  });

  it('an active plan seeds its amount, shows Remove, and Remove calls removeSpread once', async () => {
    mockParams = { categoryId: 'coffee' };
    seedBudgets({ coffee: rollup({ spread: activePlan }) });
    await renderWithQueries(<BudgetSpread />);

    expect(screen.getByTestId('spread-amount').props.value).toBe('300');     // seeded from the active plan
    await act(async () => { fireEvent.press(screen.getByTestId('spread-remove')); });

    expect(mockRemoveSpread).toHaveBeenCalledTimes(1);
    expect(mockRemoveSpread).toHaveBeenCalledWith('coffee');
    await waitFor(() => expect(mockBack).toHaveBeenCalled());
  });

  it('the amount field keeps only a single decimal point (shown matches saved)', async () => {
    // FAIL-ON-REVERT for cleanAmount: a second dot in "5.5.5" would otherwise display but the
    // parsed/saved value would be 5.5 — the field must collapse it so shown === saved.
    mockParams = { categoryId: 'coffee' };
    seedBudgets({ coffee: rollup() });
    await renderWithQueries(<BudgetSpread />);

    // "5.5.5" collapses the stray second dot (digits kept) → "5.55", which is exactly what
    // parseFloat saves, so the shown value and the saved value agree.
    fireEvent.changeText(screen.getByTestId('spread-amount'), '5.5.5');
    expect(screen.getByTestId('spread-amount').props.value).toBe('5.55');
    await act(async () => { fireEvent.press(screen.getByTestId('spread-save')); });
    expect(mockSaveSpread).toHaveBeenCalledWith('coffee', 5.55, 3);
  });

  it('a fresh spread (no plan) shows no Remove button', async () => {
    mockParams = { categoryId: 'coffee', prefill: '120' };
    seedBudgets({ coffee: rollup() });
    await renderWithQueries(<BudgetSpread />);

    expect(screen.queryByTestId('spread-remove')).toBeNull();
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
    mockParams = { id: 'coffee' };
    // posted 130 > budget 100 → over, no plan.
    seedDetail({ posted: 130 });
    await renderWithQueries(<BudgetDetail />);

    expect(screen.getByText('Spread this bill over pay cycles')).toBeTruthy();
    expect(screen.queryByText('Edit or remove bill spread')).toBeNull();
  });

  it('an active plan → "Edit or remove bill spread" stays reachable even when the cushion clears over', async () => {
    mockParams = { id: 'coffee' };
    // cushion makes spent < available, so `over` is false — the entry must key off the plan, not over.
    seedDetail({ posted: 250, spread: { amount: 300, cycles: 4, index: 0, adjustment: 300 } });
    await renderWithQueries(<BudgetDetail />);

    expect(screen.getByText('Edit or remove bill spread')).toBeTruthy();
    expect(screen.queryByText('Spread this bill over pay cycles')).toBeNull();
  });

  it('a rollover category that is over budget offers NO spread entry', async () => {
    mockParams = { id: 'coffee' };
    seedDetail({ posted: 130, rollover: true, carryover: -50 });
    await renderWithQueries(<BudgetDetail />);

    expect(screen.queryByTestId('budget-spread')).toBeNull();
  });
});
