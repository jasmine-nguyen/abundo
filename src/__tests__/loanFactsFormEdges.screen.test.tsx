// Loan facts card — app/loan.tsx client-guard boundaries the happy-path form test
// (loanFactsForm.screen.test.tsx) doesn't lock: extra == 0 allowed, lvr/ratePct at
// their exact upper bounds allowed, lvr == 0 blocked, and — the anti-wipe guard —
// pressing Save on a blank form (a form opened before facts loaded) must NOT call
// the API, so it can never overwrite saved facts with empties.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { routerSpies, resetRouter } from './support/routerMock';
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react-native';
import type { AppContext, LoanFacts, LoanFactsInput } from '../context';

type LoanFormState = Pick<AppContext, 'saveLoanFacts' | 'showToast'>;

let mockState: LoanFormState;
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});
jest.mock('../auth', () => require('./support/authMock').authMockModule());

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import Loan from '../../app/loan';
import { LOANFACTS_FIELD_MAX } from '../loanLimits';
import { fmtCompact } from '../theme';
import { resetAuth } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient, renderLoaded, WithQueries } from './support/renderWithQueries';

const server = installFakeServer();
useTestQueryClient();

// Derived from the ceiling (WHIT-393) so a change to it needs no edit here. The prose is
// written out on purpose — a reworded toast must still be changed deliberately in both places.
const AT = String(LOANFACTS_FIELD_MAX);
const OVER = String(LOANFACTS_FIELD_MAX + 1);
const AMOUNT_TOAST = `Keep each amount to ${fmtCompact(LOANFACTS_FIELD_MAX)} or less.`;

const SAVED: LoanFacts = {
  original: 600000, homeValue: 770000, lvr: 0.8, ratePct: 5.74, baseRepay: 1240, extra: 200,
};

function state(over: Partial<LoanFormState>): LoanFormState {
  return { saveLoanFacts: jest.fn() as LoanFormState['saveLoanFacts'], showToast: jest.fn() as AppContext['showToast'], ...over };
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

beforeEach(() => {
  resetRouter();
  resetAuth();
});

it('accepts Extra = 0 (optional top-up) and saves', async () => {
  const saveLoanFacts = jest.fn(async (_f: LoanFactsInput) => true);
  mockState = state({ saveLoanFacts: saveLoanFacts as AppContext['saveLoanFacts'] });
  await renderLoaded(<Loan />);
  fill({ extra: '0' });
  await act(async () => { fireEvent.press(screen.getByText('Save loan details')); });
  expect(saveLoanFacts).toHaveBeenCalledWith(expect.objectContaining({ extra: 0 }));
  expect(routerSpies.back).toHaveBeenCalled();
});

it('accepts the exact upper bounds LVR = 100% and rate = 100', async () => {
  const saveLoanFacts = jest.fn(async (_f: LoanFactsInput) => true);
  mockState = state({ saveLoanFacts: saveLoanFacts as AppContext['saveLoanFacts'] });
  await renderLoaded(<Loan />);
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
  await renderLoaded(<Loan />);
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
  await renderLoaded(<Loan />);
  fill({ home: '770000abc' });   // paste can slip past the decimal-pad keyboard
  await act(async () => { fireEvent.press(screen.getByText('Save loan details')); });
  expect(saveLoanFacts).not.toHaveBeenCalled();
  expect(showToast).toHaveBeenCalled();
});

it('blocks a dollar field over the ceiling (extra) with a toast and no save', async () => {
  const saveLoanFacts = jest.fn(async (_f: LoanFactsInput) => true);
  const showToast = jest.fn();
  mockState = state({
    saveLoanFacts: saveLoanFacts as AppContext['saveLoanFacts'],
    showToast: showToast as AppContext['showToast'],
  });
  await renderLoaded(<Loan />);
  // A non-first field over the ceiling — proves the .some() check catches more than original.
  fill({ extra: OVER });
  await act(async () => { fireEvent.press(screen.getByText('Save loan details')); });
  expect(saveLoanFacts).not.toHaveBeenCalled();
  expect(showToast).toHaveBeenCalledWith(AMOUNT_TOAST);
});

it('accepts exactly the ceiling (strict >, matching the server) and saves', async () => {
  const saveLoanFacts = jest.fn(async (_f: LoanFactsInput) => true);
  mockState = state({ saveLoanFacts: saveLoanFacts as AppContext['saveLoanFacts'] });
  await renderLoaded(<Loan />);
  fill({ orig: AT });
  await act(async () => { fireEvent.press(screen.getByText('Save loan details')); });
  expect(saveLoanFacts).toHaveBeenCalledWith(expect.objectContaining({ original: LOANFACTS_FIELD_MAX }));
  expect(routerSpies.back).toHaveBeenCalled();
});

it('a blank form (opened before facts loaded) cannot wipe saved facts on Save', async () => {
  const saveLoanFacts = jest.fn(async (_f: LoanFactsInput) => true);
  const showToast = jest.fn();
  mockState = state({
    saveLoanFacts: saveLoanFacts as AppContext['saveLoanFacts'],
    showToast: showToast as AppContext['showToast'],
  });
  // Saved facts exist on the server, but their reply hasn't landed when the form opens.
  server.seed('/loanfacts', SAVED);
  const held = server.hold('/loanfacts');
  try {
    render(<WithQueries><Loan /></WithQueries>);
    // No fills — every field blank -> num() is NaN, guard fails.
    await act(async () => { fireEvent.press(screen.getByText('Save loan details')); });
    expect(saveLoanFacts).not.toHaveBeenCalled();   // no PUT -> saved facts untouched
    expect(showToast).toHaveBeenCalled();
    expect(routerSpies.back).not.toHaveBeenCalled();
  } finally {
    await act(async () => { held.release(); });
  }
});
