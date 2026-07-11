// WHIT-235 — the "Update balance" sheet for a MANUAL goal (src/components/Overlays.tsx). It
// reads the live GoalRecord from the ['goals'] cache and, on Save, resends the WHOLE manual
// record via saveGoal (a whole-record PUT upsert) with the new balance + as-of. Rendered via
// <Overlays /> with the store's `sheet` set to goalbalance (same style as PayCycleSheet's test).
// The queries mock is hand-rolled because support/screenQueryMocks doesn't expose useGoalsQuery.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
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

const fns = { saveGoal: jest.fn(async (_id: string, _body: unknown) => true), showToast: jest.fn(), setSheet: jest.fn() };

function sheetState(goalId = 'g2'): AppContext {
  return {
    sheet: { mode: 'goalbalance', goalId },
    toast: null, notif: null, dismissNotif: jest.fn(),
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
