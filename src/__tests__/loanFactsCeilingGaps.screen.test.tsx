// WHIT-382 — adversarial GAP coverage for the loan form's $1B ceiling guards (app/loan.tsx:69-80).
// The implementer's tests (loanFactsFormEdges + loanDepositTargetGaps) lock only:
//   - a required field OVER ceiling via `extra` (the shared toast),
//   - `original` at EXACTLY $1B saves,
//   - depositTarget OVER ceiling (1000000001) blocked ([A8]).
// These add the boundaries/precedence/parseAmount paths they skip — every one distinct:
//   [G1] homeValue over ceiling  -> shared toast (proves .some() isn't extra-only)
//   [G2] baseRepay over ceiling  -> shared toast
//   [G3] original  over ceiling  -> shared toast (implementer only tested original AT the bound)
//   [G4] homeValue EXACTLY $1B   -> saves (strict > lower boundary, non-original field)
//   [G5] extra     EXACTLY $1B   -> saves
//   [G6] depositTarget EXACTLY $1B -> saves (off-by-one: 1e9 must pass, 1e9+1 blocked)
//   [G7] precedence: a required field == 0 AND another over ceiling -> the FILL/positivity
//        toast wins, NOT the ceiling toast (guards ordered positivity-first)
//   [G8] non-integer over ceiling (1000000000.5) on a required field -> shared ceiling toast
//   [G9] non-integer over ceiling (1000000000.5) on depositTarget    -> deposit ceiling toast
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react-native';
import type { AppContext, LoanFacts, LoanFactsInput } from '../context';

let mockState: AppContext;
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});
jest.mock('../queries', () => require('./support/screenQueryMocks').queryMocksFromState(() => mockState));

const mockBack = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ back: mockBack, push: jest.fn() }) }));

import Loan from '../../app/loan';

const EMPTY: LoanFacts = { original: null, homeValue: null, lvr: null, ratePct: null, baseRepay: null, extra: null };

function state(over: Partial<AppContext>): AppContext {
  return { loanFacts: EMPTY, saveLoanFacts: jest.fn(), showToast: jest.fn(), ...over } as unknown as AppContext;
}

// The six required fields plus the optional deposit target. Valid baseline; override per test.
function fill(over: Partial<Record<'orig' | 'home' | 'lvr' | 'rate' | 'base' | 'extra' | 'deposit', string>> = {}) {
  const v = { orig: '600000', home: '770000', lvr: '80', rate: '5.74', base: '1240', extra: '200', deposit: '', ...over };
  fireEvent.changeText(screen.getByPlaceholderText('e.g. 600000'), v.orig);
  fireEvent.changeText(screen.getByPlaceholderText('e.g. 770000'), v.home);
  fireEvent.changeText(screen.getByPlaceholderText('e.g. 80'), v.lvr);
  fireEvent.changeText(screen.getByPlaceholderText('e.g. 5.74'), v.rate);
  fireEvent.changeText(screen.getByPlaceholderText('e.g. 3667'), v.base);
  fireEvent.changeText(screen.getByPlaceholderText('e.g. 500'), v.extra);
  fireEvent.changeText(screen.getByPlaceholderText('e.g. 120000'), v.deposit);
}

function setup() {
  const saveLoanFacts = jest.fn(async (_f: LoanFactsInput) => true);
  const showToast = jest.fn();
  mockState = state({
    saveLoanFacts: saveLoanFacts as AppContext['saveLoanFacts'],
    showToast: showToast as AppContext['showToast'],
  });
  return { saveLoanFacts, showToast };
}

beforeEach(() => { mockBack.mockClear(); });

// --- Over-ceiling on each required field the implementer skipped (only `extra` was tested) ---

it('[G1] homeValue over the $1B ceiling -> shared toast, no save', async () => {
  const { saveLoanFacts, showToast } = setup();
  render(<Loan />);
  fill({ home: '1000000001' });
  await act(async () => { fireEvent.press(screen.getByText('Save loan details')); });
  expect(showToast).toHaveBeenCalledWith('Keep each amount under $1B.');
  expect(saveLoanFacts).not.toHaveBeenCalled();
});

it('[G2] baseRepay over the $1B ceiling -> shared toast, no save', async () => {
  const { saveLoanFacts, showToast } = setup();
  render(<Loan />);
  fill({ base: '1000000001' });
  await act(async () => { fireEvent.press(screen.getByText('Save loan details')); });
  expect(showToast).toHaveBeenCalledWith('Keep each amount under $1B.');
  expect(saveLoanFacts).not.toHaveBeenCalled();
});

it('[G3] original over the $1B ceiling -> shared toast, no save', async () => {
  const { saveLoanFacts, showToast } = setup();
  render(<Loan />);
  fill({ orig: '1000000001' });
  await act(async () => { fireEvent.press(screen.getByText('Save loan details')); });
  expect(showToast).toHaveBeenCalledWith('Keep each amount under $1B.');
  expect(saveLoanFacts).not.toHaveBeenCalled();
});

// --- Exactly $1B is the strict-> lower boundary: it must SAVE, on non-original fields too ---

it('[G4] homeValue EXACTLY $1B saves (strict >, not just tested on original)', async () => {
  const { saveLoanFacts } = setup();
  render(<Loan />);
  fill({ home: '1000000000' });
  await act(async () => { fireEvent.press(screen.getByText('Save loan details')); });
  expect(saveLoanFacts).toHaveBeenCalledWith(expect.objectContaining({ homeValue: 1000000000 }));
  expect(mockBack).toHaveBeenCalled();
});

it('[G5] extra EXACTLY $1B saves', async () => {
  const { saveLoanFacts } = setup();
  render(<Loan />);
  fill({ extra: '1000000000' });
  await act(async () => { fireEvent.press(screen.getByText('Save loan details')); });
  expect(saveLoanFacts).toHaveBeenCalledWith(expect.objectContaining({ extra: 1000000000 }));
  expect(mockBack).toHaveBeenCalled();
});

it('[G6] depositTarget EXACTLY $1B saves (off-by-one: 1e9 passes, 1e9+1 blocked by [A8])', async () => {
  const { saveLoanFacts } = setup();
  render(<Loan />);
  fill({ deposit: '1000000000' });
  await act(async () => { fireEvent.press(screen.getByText('Save loan details')); });
  expect(saveLoanFacts).toHaveBeenCalledWith(expect.objectContaining({ depositTarget: 1000000000 }));
  expect(mockBack).toHaveBeenCalled();
});

// --- Precedence: an invalid (empty/zero) required field must win over a ceiling violation ---

it('[G7] a zero required field AND another over ceiling -> the fill toast wins, not the ceiling toast', async () => {
  const { saveLoanFacts, showToast } = setup();
  render(<Loan />);
  // original invalid (0) AND homeValue over ceiling: positivity guard runs first.
  fill({ orig: '0', home: '1000000001' });
  await act(async () => { fireEvent.press(screen.getByText('Save loan details')); });
  expect(showToast).toHaveBeenCalledWith('Please fill in every field with a valid amount.');
  expect(showToast).not.toHaveBeenCalledWith('Keep each amount under $1B.');
  expect(saveLoanFacts).not.toHaveBeenCalled();
});

// --- Non-integer over-ceiling: parseAmount accepts decimals, strict > still catches them ---

it('[G8] a non-integer just over ceiling (1000000000.5) on a required field is caught', async () => {
  const { saveLoanFacts, showToast } = setup();
  render(<Loan />);
  fill({ orig: '1000000000.5' });
  await act(async () => { fireEvent.press(screen.getByText('Save loan details')); });
  expect(showToast).toHaveBeenCalledWith('Keep each amount under $1B.');
  expect(saveLoanFacts).not.toHaveBeenCalled();
});

it('[G9] a non-integer just over ceiling (1000000000.5) on depositTarget is caught by its toast', async () => {
  const { saveLoanFacts, showToast } = setup();
  render(<Loan />);
  fill({ deposit: '1000000000.5' });
  await act(async () => { fireEvent.press(screen.getByText('Save loan details')); });
  expect(showToast).toHaveBeenCalledWith('Keep the deposit target under $1B.');
  expect(saveLoanFacts).not.toHaveBeenCalled();
});
