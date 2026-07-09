// WHIT-126 (adversarial gap) — EDITING a loan that ALREADY has a saved payoff goal
// date. The implementer's loanFactsForm test only covers picking a fresh date + clearing;
// this proves the form SEEDS the picker/label from the stored date and PRESERVES it on a
// save that never touches the picker (a stale-seed bug would silently wipe the goal).
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

// A fully-set loan with a saved goal date (the row the form loads when re-opened).
const SAVED: LoanFacts = {
  original: 600000, homeValue: 770000, lvr: 0.8, ratePct: 5.74,
  baseRepay: 1240, extra: 200, payoffGoalDate: '2035-06-01',
};

function state(over: Partial<LoanFormState>): LoanFormState {
  return { loanFacts: SAVED, saveLoanFacts: jest.fn() as LoanFormState['saveLoanFacts'], showToast: jest.fn() as AppContext['showToast'], ...over };
}

beforeEach(() => { mockBack.mockClear(); });

it('seeds the label from the saved goal date (not "Not set")', () => {
  mockState = state({});
  render(<Loan />);
  // parseGoalDate is LOCAL-midnight, so 2035-06-01 renders as 1 Jun 2035 in any TZ.
  expect(screen.getByText('1 Jun 2035')).toBeTruthy();
  expect(screen.queryByText('Not set')).toBeNull();
});

it('preserves the saved goal date on a save that never opens the picker', async () => {
  const saveLoanFacts = jest.fn(async (_f: LoanFactsInput) => true);
  mockState = state({ saveLoanFacts: saveLoanFacts as AppContext['saveLoanFacts'] });
  render(<Loan />);
  await act(async () => { fireEvent.press(screen.getByText('Save loan details')); });
  // The pre-existing date rides along untouched — a stale-seed bug would send null here.
  expect(saveLoanFacts).toHaveBeenCalledWith(expect.objectContaining({ payoffGoalDate: '2035-06-01' }));
  expect(mockBack).toHaveBeenCalled();
});

it('clears a previously-saved goal date back to null', async () => {
  const saveLoanFacts = jest.fn(async (_f: LoanFactsInput) => true);
  mockState = state({ saveLoanFacts: saveLoanFacts as AppContext['saveLoanFacts'] });
  render(<Loan />);
  await act(async () => { fireEvent.press(screen.getByText('Clear')); });
  expect(screen.getByText('Not set')).toBeTruthy();
  await act(async () => { fireEvent.press(screen.getByText('Save loan details')); });
  expect(saveLoanFacts).toHaveBeenCalledWith(expect.objectContaining({ payoffGoalDate: null }));
});
