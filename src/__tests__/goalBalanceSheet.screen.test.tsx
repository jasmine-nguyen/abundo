// WHIT-235 — the "Update balance" sheet for a MANUAL goal (src/components/Overlays.tsx). It
// reads the live GoalRecord from the ['goals'] cache and, on Save, resends the WHOLE manual
// record via saveGoal (a whole-record PUT upsert) with the new balance + as-of. Rendered via
// <Overlays /> with the store's `sheet` set to goalbalance (same style as PayCycleSheet's test).
// The queries mock is hand-rolled because support/screenQueryMocks doesn't expose useGoalsQuery.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { Modal } from 'react-native';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react-native';
import type { AppContext } from '../context';
import type { GoalRecord } from '../api';

let mockState: AppContext;
let mockGoals: GoalRecord[];

jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});
jest.mock('../queries', () => ({
  useIsAuthed: () => true,
  useGoalsQuery: () => ({ data: mockGoals }),
}));

import { Overlays } from '../components/Overlays';

const ISO = /^\d{4}-\d{2}-\d{2}$/;

// A manual pay-down goal (no account_id — the manual arm).
const CAR_LOAN: GoalRecord = {
  id: 'g2', name: 'Car loan', icon: 'car', direction: 'paydown',
  target_amount: 0, target_date: '2027-08-15', baseline: 20000,
  account_id: null, manual_balance: 12000, manual_as_of: '2026-07-01',
};

// A DIFFERENT manual goal, seeded balance 300 — used by the gaps block to prove the per-goal re-seed.
const HOLIDAY: GoalRecord = {
  id: 'g5', name: 'Holiday fund', icon: 'plane', direction: 'grow',
  target_amount: 4000, target_date: '2027-01-01', baseline: 0,
  account_id: null, manual_balance: 300, manual_as_of: '2026-07-02',
};

const fns = { saveGoal: jest.fn(async (_id: string, _body: unknown) => true), showToast: jest.fn(), setSheet: jest.fn(), readSheetDraft: () => undefined, writeSheetDraft: () => {} };

function sheetState(goalId = 'g2'): AppContext {
  return {
    sheet: { mode: 'goalbalance', goalId },
    toast: null,
    ...fns,
  } as unknown as AppContext;
}

beforeEach(() => {
  fns.saveGoal.mockClear().mockImplementation(async () => true);
  fns.showToast.mockClear();
  fns.setSheet.mockClear();
  mockGoals = [CAR_LOAN];
  mockState = sheetState();
});

it('shows the goal name and prefills the current balance', () => {
  render(<Overlays />);
  expect(screen.getByText(/Car loan/)).toBeTruthy();
  expect(screen.getByDisplayValue('12000')).toBeTruthy();
});

it('Save resends the FULL manual record with the new balance + as-of today, then closes', async () => {
  render(<Overlays />);
  fireEvent.changeText(screen.getByTestId('goal-balance-input'), '9500');
  await act(async () => { fireEvent.press(screen.getByTestId('goal-balance-save')); });

  expect(fns.saveGoal).toHaveBeenCalledTimes(1);
  const [id, body] = fns.saveGoal.mock.calls[0] as [string, Record<string, unknown>];
  expect(id).toBe('g2');
  // Every non-balance field rides along unchanged (a whole-record upsert) — nothing lost.
  expect(body).toMatchObject({
    name: 'Car loan', icon: 'car', direction: 'paydown',
    target_amount: 0, target_date: '2027-08-15', baseline: 20000,
    manual_balance: 9500,
  });
  expect(body.manual_as_of).toMatch(ISO); // defaults to today
  expect(body).not.toHaveProperty('account_id'); // the manual arm only
  await waitFor(() => expect(fns.setSheet).toHaveBeenCalledWith(null));
});

it('a $0 balance is valid (a paid-off manual debt)', async () => {
  render(<Overlays />);
  fireEvent.changeText(screen.getByTestId('goal-balance-input'), '0');
  await act(async () => { fireEvent.press(screen.getByTestId('goal-balance-save')); });
  expect(fns.showToast).not.toHaveBeenCalled();
  const [, body] = fns.saveGoal.mock.calls[0] as [string, Record<string, unknown>];
  expect(body).toMatchObject({ manual_balance: 0 });
});

it('rejects a non-numeric balance with a toast and no save', async () => {
  render(<Overlays />);
  fireEvent.changeText(screen.getByTestId('goal-balance-input'), '12abc');
  await act(async () => { fireEvent.press(screen.getByTestId('goal-balance-save')); });
  expect(fns.showToast).toHaveBeenCalledWith('Enter a balance of $0 or more.');
  expect(fns.saveGoal).not.toHaveBeenCalled();
});

it('rejects a negative balance', async () => {
  render(<Overlays />);
  fireEvent.changeText(screen.getByTestId('goal-balance-input'), '-5');
  await act(async () => { fireEvent.press(screen.getByTestId('goal-balance-save')); });
  expect(fns.showToast).toHaveBeenCalledWith('Enter a balance of $0 or more.');
  expect(fns.saveGoal).not.toHaveBeenCalled();
});

it('a failed save keeps the sheet OPEN (does not navigate/close)', async () => {
  fns.saveGoal.mockImplementation(async () => false);
  render(<Overlays />);
  fireEvent.changeText(screen.getByTestId('goal-balance-input'), '9500');
  await act(async () => { fireEvent.press(screen.getByTestId('goal-balance-save')); });
  expect(fns.saveGoal).toHaveBeenCalledTimes(1);
  await act(async () => {});
  expect(fns.setSheet).not.toHaveBeenCalled();
});

it('renders nothing when the goal is absent (deleted elsewhere / cold cache)', () => {
  mockGoals = []; // g2 not in the cache
  render(<Overlays />);
  expect(screen.queryByTestId('goal-balance-save')).toBeNull();
});

it('picking a date backdates manual_as_of to the chosen ISO date', async () => {
  render(<Overlays />);
  fireEvent.changeText(screen.getByTestId('goal-balance-input'), '9500');
  fireEvent.press(screen.getByTestId('mock-datepicker')); // the mock fires 2026-06-20
  await act(async () => { fireEvent.press(screen.getByTestId('goal-balance-save')); });
  const [, body] = fns.saveGoal.mock.calls[0] as [string, Record<string, unknown>];
  expect(body.manual_as_of).toBe('2026-06-20');
});

// ===== WHIT-235 adversarial gaps (folded from goalBalanceSheetGaps) — blank/decimal balance, the
// per-goal re-seed on remount, and the hardware-back dismiss. Own beforeEach seeds a SECOND goal. =====
describe('goal-balance sheet — adversarial gaps (WHIT-235)', () => {
  beforeEach(() => {
    mockGoals = [CAR_LOAN, HOLIDAY];
    mockState = sheetState();
  });

  // [A18] a BLANK balance is rejected — the tests above cover '12abc' and '-5' but never the
  // empty string, which is the most common real mis-tap (open sheet, clear field, hit save).
  it('rejects a blank balance with a toast and no save', async () => {
    render(<Overlays />);
    fireEvent.changeText(screen.getByTestId('goal-balance-input'), '');
    await act(async () => { fireEvent.press(screen.getByTestId('goal-balance-save')); });
    expect(fns.showToast).toHaveBeenCalledWith('Enter a balance of $0 or more.');
    expect(fns.saveGoal).not.toHaveBeenCalled();
  });

  // [A19] a DECIMAL like "12.5" is accepted and passed through unrounded — the whole point of the
  // decimal-pad. The tests above only exercised whole numbers, so nothing proves the fractional path.
  it('accepts a decimal balance and passes it through as a float', async () => {
    render(<Overlays />);
    fireEvent.changeText(screen.getByTestId('goal-balance-input'), '12.5');
    await act(async () => { fireEvent.press(screen.getByTestId('goal-balance-save')); });
    expect(fns.showToast).not.toHaveBeenCalled();
    const [, body] = fns.saveGoal.mock.calls[0] as [string, Record<string, unknown>];
    expect(body).toMatchObject({ manual_balance: 12.5 });
  });

  // [A20] the sheet RE-SEEDS its balance per goal. SheetHost keys the sheet on goalId, so switching
  // which goal is open must remount and re-run the useState initialiser off the NEW record — else a
  // stale 12000 would ride into the wrong goal's save. Guards the key={goalId} remount.
  it('re-seeds the balance input when reopened for a different goalId', () => {
    const { rerender } = render(<Overlays />);
    expect(screen.getByDisplayValue('12000')).toBeTruthy(); // g2
    mockState = sheetState('g5');
    rerender(<Overlays />);
    expect(screen.getByDisplayValue('300')).toBeTruthy();   // g5 — not the stale 12000
    expect(screen.queryByDisplayValue('12000')).toBeNull();
  });

  // [A21] hardware-back / scrim dismiss closes the sheet via setSheet(null). onRequestClose is the
  // back-button + is wired identically to the scrim tap (the shared SheetHost dismiss).
  it('dismissing via hardware back closes the sheet (setSheet null)', () => {
    render(<Overlays />);
    fireEvent(screen.UNSAFE_getByType(Modal), 'requestClose');
    expect(fns.setSheet).toHaveBeenCalledWith(null);
  });
});
