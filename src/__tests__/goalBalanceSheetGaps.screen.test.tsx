// WHIT-235 — GAP tests for the manual-goal "Update balance" sheet (src/components/Overlays.tsx).
// Independent/adversarial half: covers what goalBalanceSheet.screen.test.tsx does NOT — a blank
// balance, a real decimal passed through, the per-goal re-seed on remount (key={goalId}), and the
// hardware-back / scrim dismiss path. Same harness: render <Overlays /> with useAppContext mocked
// + a hand-rolled ../queries mock exposing useGoalsQuery/useIsAuthed (PayCycleSheet-style).
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { Modal } from 'react-native';
import { render, screen, fireEvent, act } from '@testing-library/react-native';
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

// A manual pay-down goal (no account_id — the manual arm), seeded balance 12000.
const CAR_LOAN: GoalRecord = {
  id: 'g2', name: 'Car loan', icon: 'car', direction: 'paydown',
  target_amount: 0, target_date: '2027-08-15', baseline: 20000,
  account_id: null, manual_balance: 12000, manual_as_of: '2026-07-01',
};
// A DIFFERENT manual goal, seeded balance 300 — used to prove the per-goal re-seed.
const HOLIDAY: GoalRecord = {
  id: 'g5', name: 'Holiday fund', icon: 'plane', direction: 'grow',
  target_amount: 4000, target_date: '2027-01-01', baseline: 0,
  account_id: null, manual_balance: 300, manual_as_of: '2026-07-02',
};

const fns = { saveGoal: jest.fn(async (_id: string, _body: unknown) => true), showToast: jest.fn(), setSheet: jest.fn(), readSheetDraft: () => undefined, writeSheetDraft: () => {} };

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
  mockGoals = [CAR_LOAN, HOLIDAY];
  mockState = sheetState();
});

// [A18] a BLANK balance is rejected — the implementer tested '12abc' and '-5' but never the
// empty string, which is the most common real mis-tap (open sheet, clear field, hit save).
it('rejects a blank balance with a toast and no save', async () => {
  render(<Overlays />);
  fireEvent.changeText(screen.getByTestId('goal-balance-input'), '');
  await act(async () => { fireEvent.press(screen.getByTestId('goal-balance-save')); });
  expect(fns.showToast).toHaveBeenCalledWith('Enter a balance of $0 or more.');
  expect(fns.saveGoal).not.toHaveBeenCalled();
});

// [A19] a DECIMAL like "12.5" is accepted and passed through unrounded — the whole point of the
// decimal-pad. The implementer only exercised whole numbers (9500, 0), so nothing proves the
// fractional path actually reaches saveGoal.
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

// [A21] hardware-back / scrim dismiss closes the sheet via setSheet(null). No existing test covers
// the dismiss path for this sheet; onRequestClose is the back-button + is wired identically to the
// scrim tap. (Exercises the shared SheetHost dismiss — unchanged by WHIT-235 — through this sheet.)
it('dismissing via hardware back closes the sheet (setSheet null)', () => {
  render(<Overlays />);
  fireEvent(screen.UNSAFE_getByType(Modal), 'requestClose');
  expect(fns.setSheet).toHaveBeenCalledWith(null);
});
