// Loan facts card — app/loan.tsx client-guard boundaries the happy-path form test
// (loanFactsForm.screen.test.tsx) doesn't lock: extra == 0 allowed, lvr/ratePct at
// their exact upper bounds allowed, lvr == 0 blocked, and — the anti-wipe guard —
// pressing Save on a blank form (a form opened before facts loaded) must NOT call
// the API, so it can never overwrite saved facts with empties.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react-native';
import type { AppContext, LoanFacts, LoanFactsInput } from '../context';

let mockState: AppContext;
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});

const mockBack = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ back: mockBack, push: jest.fn() }) }));

import Loan from '../../app/loan';

const EMPTY: LoanFacts = { original: null, homeValue: null, lvr: null, ratePct: null, baseRepay: null, extra: null };

function state(over: Partial<AppContext>): AppContext {
  return { loanFacts: EMPTY, saveLoanFacts: jest.fn(), showToast: jest.fn(), ...over } as unknown as AppContext;
}

function fill(over: Partial<Record<'orig' | 'home' | 'lvr' | 'rate' | 'base' | 'extra', string>> = {}) {
  const v = { orig: '600000', home: '770000', lvr: '80', rate: '5.74', base: '1240', extra: '200', ...over };
  fireEvent.changeText(screen.getByPlaceholderText('e.g. 600000'), v.orig);
  fireEvent.changeText(screen.getByPlaceholderText('e.g. 770000'), v.home);
  fireEvent.changeText(screen.getByPlaceholderText('e.g. 80'), v.lvr);
  fireEvent.changeText(screen.getByPlaceholderText('e.g. 5.74'), v.rate);
  fireEvent.changeText(screen.getByPlaceholderText('e.g. 3667'), v.base);
  fireEvent.changeText(screen.getByPlaceholderText('e.g. 500'), v.extra);
}

beforeEach(() => { mockBack.mockClear(); });

it('accepts Extra = 0 (optional top-up) and saves', async () => {
  const saveLoanFacts = jest.fn(async (_f: LoanFactsInput) => true);
  mockState = state({ saveLoanFacts: saveLoanFacts as AppContext['saveLoanFacts'] });
  render(<Loan />);
  fill({ extra: '0' });
  await act(async () => { fireEvent.press(screen.getByText('Save loan details')); });
  expect(saveLoanFacts).toHaveBeenCalledWith(expect.objectContaining({ extra: 0 }));
  expect(mockBack).toHaveBeenCalled();
});

it('accepts the exact upper bounds LVR = 100% and rate = 100', async () => {
  const saveLoanFacts = jest.fn(async (_f: LoanFactsInput) => true);
  mockState = state({ saveLoanFacts: saveLoanFacts as AppContext['saveLoanFacts'] });
  render(<Loan />);
  fill({ lvr: '100', rate: '100' });   // client guard is lvr<=1 (fraction) and ratePct<=100
  await act(async () => { fireEvent.press(screen.getByText('Save loan details')); });
  expect(saveLoanFacts).toHaveBeenCalledWith(expect.objectContaining({ lvr: 1, ratePct: 100 }));
});

it('blocks LVR = 0 (must be > 0) with a toast and no save', async () => {
  const saveLoanFacts = jest.fn(async (_f: LoanFactsInput) => true);
  const showToast = jest.fn();
  mockState = state({
    saveLoanFacts: saveLoanFacts as AppContext['saveLoanFacts'],
    showToast: showToast as AppContext['showToast'],
  });
  render(<Loan />);
  fill({ lvr: '0' });
  await act(async () => { fireEvent.press(screen.getByText('Save loan details')); });
  expect(saveLoanFacts).not.toHaveBeenCalled();
  expect(showToast).toHaveBeenCalled();
});

it('rejects trailing garbage in a number ("80abc") rather than storing 80', async () => {
  const saveLoanFacts = jest.fn(async (_f: LoanFactsInput) => true);
  const showToast = jest.fn();
  mockState = state({
    saveLoanFacts: saveLoanFacts as AppContext['saveLoanFacts'],
    showToast: showToast as AppContext['showToast'],
  });
  render(<Loan />);
  fill({ home: '770000abc' });   // paste can slip past the decimal-pad keyboard
  await act(async () => { fireEvent.press(screen.getByText('Save loan details')); });
  expect(saveLoanFacts).not.toHaveBeenCalled();
  expect(showToast).toHaveBeenCalled();
});

it('a blank form (opened before facts loaded) cannot wipe saved facts on Save', async () => {
  const saveLoanFacts = jest.fn(async (_f: LoanFactsInput) => true);
  const showToast = jest.fn();
  mockState = state({
    saveLoanFacts: saveLoanFacts as AppContext['saveLoanFacts'],
    showToast: showToast as AppContext['showToast'],
  });
  render(<Loan />);
  // No fills — every field blank -> num() is NaN, guard fails.
  await act(async () => { fireEvent.press(screen.getByText('Save loan details')); });
  expect(saveLoanFacts).not.toHaveBeenCalled();   // no PUT -> saved facts untouched
  expect(showToast).toHaveBeenCalled();
  expect(mockBack).not.toHaveBeenCalled();
});
