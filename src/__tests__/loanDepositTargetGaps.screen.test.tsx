// WHIT-378 — adversarial GAP coverage for the Loan form's deposit-target guard + clear.
// Implementer's loanFactsForm.screen.test.tsx locks: typed number saves, blank saves null,
// seeds from saved facts. These add the paths it skips:
//   [A6] garbage ("12abc") in the target -> the DEPOSIT-SPECIFIC toast fires and NOTHING
//        saves (distinct from the six-field toast; exercises app/loan.tsx:63-66).
//   [A7] EDIT flow: a seeded target cleared back to blank saves depositTarget:null
//        (mirrors the payoffGoalDate clear test the implementer only wrote for the date).
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react-native';
import type { AppContext, LoanFacts, LoanFactsInput } from '../context';

type LoanFormState = Pick<AppContext, 'saveLoanFacts' | 'showToast'> & { loanFacts: LoanFacts };

let mockState: LoanFormState;
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});
jest.mock('../queries', () => require('./support/screenQueryMocks').queryMocksFromState(() => mockState));

const mockBack = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ back: mockBack, push: jest.fn() }) }));

import Loan from '../../app/loan';
import { LOANFACTS_FIELD_MAX } from '../loanLimits';
import { fmtCompact } from '../theme';

// Derived from the ceiling (WHIT-393) so a change to it needs no edit here. The prose is
// written out on purpose — a reworded toast must still be changed deliberately in both places.
const OVER = String(LOANFACTS_FIELD_MAX + 1);
const DEPOSIT_TOAST = `Keep the deposit target to ${fmtCompact(LOANFACTS_FIELD_MAX)} or less.`;

const EMPTY: LoanFacts = { original: null, homeValue: null, lvr: null, ratePct: null, baseRepay: null, extra: null };

function state(over: Partial<LoanFormState>): LoanFormState {
  return { loanFacts: EMPTY, saveLoanFacts: jest.fn() as LoanFormState['saveLoanFacts'], showToast: jest.fn() as AppContext['showToast'], ...over };
}

function fillValid() {
  fireEvent.changeText(screen.getByPlaceholderText('e.g. 600000'), '600000');
  fireEvent.changeText(screen.getByPlaceholderText('e.g. 770000'), '770000');
  fireEvent.changeText(screen.getByPlaceholderText('e.g. 80'), '80');
  fireEvent.changeText(screen.getByPlaceholderText('e.g. 5.74'), '5.74');
  fireEvent.changeText(screen.getByPlaceholderText('e.g. 3667'), '1240');
  fireEvent.changeText(screen.getByPlaceholderText('e.g. 500'), '200');
}

beforeEach(() => { mockBack.mockClear(); });

it('[A6] garbage deposit target (all six fields valid) is blocked by the target toast, no save', async () => {
  const saveLoanFacts = jest.fn(async (_f: LoanFactsInput) => true);
  const showToast = jest.fn();
  mockState = state({ saveLoanFacts: saveLoanFacts as AppContext['saveLoanFacts'], showToast: showToast as AppContext['showToast'] });
  render(<Loan />);
  fillValid();
  fireEvent.changeText(screen.getByPlaceholderText('e.g. 120000'), '12abc');
  await act(async () => { fireEvent.press(screen.getByText('Save loan details')); });

  // The six-field guard passes, so it's the DEPOSIT-specific message that fires...
  expect(showToast).toHaveBeenCalledWith('Enter a valid deposit target, or leave it blank.');
  // ...and nothing is persisted or navigated. Fail-on-revert: drop the app/loan.tsx:63 guard
  // and NaN sails through to saveLoanFacts.
  expect(saveLoanFacts).not.toHaveBeenCalled();
  expect(mockBack).not.toHaveBeenCalled();
});

it('[A6b] a zero deposit target is rejected the same way (> 0 guard, not just finiteness)', async () => {
  const saveLoanFacts = jest.fn(async (_f: LoanFactsInput) => true);
  const showToast = jest.fn();
  mockState = state({ saveLoanFacts: saveLoanFacts as AppContext['saveLoanFacts'], showToast: showToast as AppContext['showToast'] });
  render(<Loan />);
  fillValid();
  fireEvent.changeText(screen.getByPlaceholderText('e.g. 120000'), '0');
  await act(async () => { fireEvent.press(screen.getByText('Save loan details')); });
  expect(showToast).toHaveBeenCalledWith('Enter a valid deposit target, or leave it blank.');
  expect(saveLoanFacts).not.toHaveBeenCalled();
});

it('[A8] a deposit target over the ceiling is blocked by its own toast, no save', async () => {
  const saveLoanFacts = jest.fn(async (_f: LoanFactsInput) => true);
  const showToast = jest.fn();
  mockState = state({ saveLoanFacts: saveLoanFacts as AppContext['saveLoanFacts'], showToast: showToast as AppContext['showToast'] });
  render(<Loan />);
  fillValid();
  fireEvent.changeText(screen.getByPlaceholderText('e.g. 120000'), OVER);
  await act(async () => { fireEvent.press(screen.getByText('Save loan details')); });
  // Distinct from the finite/>0 toast — this is the ceiling message. Fail-on-revert: drop the
  // deposit-target ceiling guard and an over-ceiling value sails through to saveLoanFacts.
  expect(showToast).toHaveBeenCalledWith(DEPOSIT_TOAST);
  expect(saveLoanFacts).not.toHaveBeenCalled();
  expect(mockBack).not.toHaveBeenCalled();
});

it('[A7] EDIT: a seeded target cleared to blank saves depositTarget:null (no stale value)', async () => {
  const saveLoanFacts = jest.fn(async (_f: LoanFactsInput) => true);
  mockState = state({
    saveLoanFacts: saveLoanFacts as AppContext['saveLoanFacts'],
    loanFacts: { original: 600000, homeValue: 770000, lvr: 0.8, ratePct: 5.74, baseRepay: 1240, extra: 200, depositTarget: 120000 },
  });
  render(<Loan />);
  expect(screen.getByDisplayValue('120000')).toBeTruthy();   // seeded
  fireEvent.changeText(screen.getByDisplayValue('120000'), '');  // user clears it
  await act(async () => { fireEvent.press(screen.getByText('Save loan details')); });
  expect(saveLoanFacts).toHaveBeenCalledWith(expect.objectContaining({ depositTarget: null }));
});
