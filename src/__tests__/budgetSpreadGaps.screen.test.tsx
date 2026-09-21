// WHIT-505 — bill-spread SCREEN gap tests (adversarial half). Same mock pattern as
// budgetSpread.screen.test.tsx (keep the REAL context, override useAppContext, drive query
// hooks from mockState). Covers the interactions the implementer's suite skips: stepper
// clamps at the [1,24] bounds, save-returns-false keeps the screen mounted + re-enabled, a
// same-frame double-tap fires the writer once, the Income deep-link guard, an undefined
// categoryId, and the entry point's ABSENCE when a spend category is under budget with no plan.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react-native';
import type { AppContext } from '../context';
import type { ScreenState } from './support/screenQueryMocks';

const mockSaveSpread = jest.fn(async (_id: string, _amount: number, _cycles: number) => true);
const mockRemoveSpread = jest.fn(async (_id: string) => true);
const mockBack = jest.fn();

const SPEND = { id: 'coffee', name: 'Cafes & Coffee', icon: 'coffee', color: '#E8A87C', bucket: 'Lifestyle', recent: 52 };
const INCOME = { id: 'salary', name: 'Salary', icon: 'briefcase', color: '#7CC5E8', bucket: 'Income', recent: 5000 };
let mockState: AppContext | ScreenState;
let mockParams: { categoryId?: string; prefill?: string; id?: string } = { categoryId: 'coffee' };

jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});
jest.mock('../queries', () => require('./support/screenQueryMocks').queryMocksFromState(() => mockState));
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: mockBack, dismissAll: jest.fn() }),
  useLocalSearchParams: () => mockParams,
}));

import BudgetSpread from '../../app/budget/spread';
import BudgetDetail from '../../app/budget/[id]';

const spendBudget = (over = {}) => ({ id: 'coffee', budget: 100, posted: 0, pending: 0, rollover: false, carryover: 0, spreadAdjustment: 0, ...over });
const spreadCtx = (over = {}) => ({ categories: [SPEND], budgets: [spendBudget(over)], saveSpread: mockSaveSpread, removeSpread: mockRemoveSpread } as unknown as AppContext);

beforeEach(() => {
  mockSaveSpread.mockReset();
  mockSaveSpread.mockImplementation(async () => true);
  mockRemoveSpread.mockReset();
  mockRemoveSpread.mockImplementation(async () => true);
  mockBack.mockClear();
  mockParams = { categoryId: 'coffee' };
});

// ── stepper clamps at the [1,24] bounds ──────────────────────────────────────
describe('app/budget/spread.tsx — stepper bounds', () => {
  // [G10] Minus is enabled above the floor, disabled AT the floor, and the value never drops
  // below 1. Fail-on-revert: dropping `disabled={cycles <= SPREAD_MIN_CYCLES}` un-disables it.
  it('[G10] the minus button disables at 1 cycle and never steps below', async () => {
    mockParams = { categoryId: 'coffee', prefill: '120' };
    mockState = spreadCtx();
    render(<BudgetSpread />);

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

  // [G11] Plus disables AT the ceiling (24, the active plan's cycle count) and never steps past.
  it('[G11] the plus button disables at 24 cycles and never steps above', () => {
    mockParams = { categoryId: 'coffee' };
    mockState = spreadCtx({ spreadAdjustment: -100, spread: { amount: 2400, cycles: 24, index: 1, adjustment: -100 } });
    render(<BudgetSpread />);

    const plus = () => screen.getByTestId('spread-cycles-plus');
    expect(screen.getByText('24')).toBeTruthy();                         // seeded from the plan
    expect(plus().props.accessibilityState?.disabled).toBe(true);        // ceiling reached
    fireEvent.press(plus());   // blocked
    expect(screen.getByText('24')).toBeTruthy();                         // still 24
  });
});

// ── save failure keeps the screen usable ─────────────────────────────────────
describe('app/budget/spread.tsx — save failure', () => {
  // [G12] saveSpread returning false must NOT navigate back and must re-enable the button so
  // the user can retry (a second press fires the writer again). Fail-on-revert: making the
  // save call router.back() unconditionally, or dropping the else-branch setSubmitting(false),
  // breaks one half of this each.
  it('[G12] saveSpread → false leaves the screen mounted and re-enabled for retry', async () => {
    mockParams = { categoryId: 'coffee', prefill: '120' };
    mockSaveSpread.mockImplementation(async () => false);
    mockState = spreadCtx();
    render(<BudgetSpread />);

    await act(async () => { fireEvent.press(screen.getByTestId('spread-save')); });
    expect(mockSaveSpread).toHaveBeenCalledTimes(1);
    expect(mockBack).not.toHaveBeenCalled();                             // stayed on the screen

    await act(async () => { fireEvent.press(screen.getByTestId('spread-save')); });
    expect(mockSaveSpread).toHaveBeenCalledTimes(2);                     // re-enabled → retried
    expect(mockBack).not.toHaveBeenCalled();
  });

  // [G13] A same-frame double-tap (both presses land before the pending save resolves) must
  // fire the writer exactly once — the in-flight latch + submitting gate. Fail-on-revert:
  // bypassing runSave (calling s.saveSpread directly) fires it twice.
  it('[G13] a double-tap while the save is in flight fires the writer once', async () => {
    mockParams = { categoryId: 'coffee', prefill: '120' };
    let resolveSave: (v: boolean) => void = () => {};
    mockSaveSpread.mockImplementation(() => new Promise<boolean>((res) => { resolveSave = res; }));
    mockState = spreadCtx();
    render(<BudgetSpread />);

    await act(async () => {
      fireEvent.press(screen.getByTestId('spread-save'));
      fireEvent.press(screen.getByTestId('spread-save'));   // same frame, save still pending
    });
    expect(mockSaveSpread).toHaveBeenCalledTimes(1);
    await act(async () => { resolveSave(true); });
    await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
  });
});

// ── deep-link guards ─────────────────────────────────────────────────────────
describe('app/budget/spread.tsx — deep-link guards', () => {
  // [G14] An Income category deep-linked into the spread screen renders the note, NOT the
  // amount form (a spread is spend-only; the server would reject it). Fail-on-revert: dropping
  // the Income/Savings bucket guard renders the form.
  it('[G14] an Income category shows the note, not the amount form', () => {
    mockParams = { categoryId: 'salary' };
    mockState = { categories: [INCOME], budgets: [], saveSpread: mockSaveSpread, removeSpread: mockRemoveSpread } as unknown as AppContext;
    render(<BudgetSpread />);

    expect(screen.getByText('Only spend categories can spread a bill.')).toBeTruthy();
    expect(screen.queryByTestId('spread-amount')).toBeNull();
    expect(screen.queryByTestId('spread-save')).toBeNull();
  });

  // [G15] An undefined categoryId (deep link with no param / category not resolved) must not
  // crash — it renders just the header, no form. Fail-on-revert: dropping the `if (!cat)` guard
  // dereferences cat and throws.
  it('[G15] an undefined categoryId renders the header only, no form, no crash', () => {
    mockParams = {} as { categoryId?: string };
    mockState = { categories: [SPEND], budgets: [], saveSpread: mockSaveSpread, removeSpread: mockRemoveSpread } as unknown as AppContext;
    expect(() => render(<BudgetSpread />)).not.toThrow();
    expect(screen.queryByTestId('spread-amount')).toBeNull();
    expect(screen.queryByTestId('spread-save')).toBeNull();
  });
});

// ── entry point absence ──────────────────────────────────────────────────────
describe('app/budget/[id].tsx — spread entry absent under budget', () => {
  const detailState = (over = {}) => ({
    categories: [SPEND], transactions: [], cycleLen: 14, daysLeft: 7,
    budgets: [spendBudget(over)],
  }) as unknown as ScreenState;

  // [G16] A spend category UNDER budget with no plan offers no spread entry at all
  // (canStartSpread requires currently-over — decision 3). Fail-on-revert: forcing
  // canStartSpread true (dropping the `over &&` gate) makes the button appear.
  it('[G16] under budget with no plan → no spread entry point', () => {
    mockParams = { id: 'coffee' };
    mockState = { ...detailState({ posted: 40 }), deleteBudget: jest.fn() } as unknown as AppContext;  // 40 < 100
    render(<BudgetDetail />);

    expect(screen.queryByTestId('budget-spread')).toBeNull();
    expect(screen.queryByText('Spread this bill over pay cycles')).toBeNull();
    expect(screen.queryByText('Edit or remove bill spread')).toBeNull();
  });
});
