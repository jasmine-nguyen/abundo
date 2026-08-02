// WHIT-382 — adversarial GAP coverage for the loan form's dollar-ceiling guards (app/loan.tsx).
// The implementer's tests (loanFactsFormEdges + loanDepositTargetGaps) lock only:
//   - a required field OVER the ceiling via `extra` (the shared toast),
//   - `original` EXACTLY at the ceiling saves,
//   - depositTarget OVER the ceiling blocked ([A8]).
// These add the boundaries/precedence/parseAmount paths they skip — every one distinct:
//   [G1] homeValue over the ceiling -> shared toast (proves .some() isn't extra-only)
//   [G2] baseRepay over the ceiling -> shared toast
//   [G3] original  over the ceiling -> shared toast (implementer only tested original AT the bound)
//   [G4] homeValue EXACTLY at the ceiling -> saves (strict > lower boundary, non-original field)
//   [G5] extra     EXACTLY at the ceiling -> saves
//   [G6] depositTarget EXACTLY at the ceiling -> saves (off-by-one: at passes, +1 blocked)
//   [G7] precedence: a required field == 0 AND another over the ceiling -> the FILL/positivity
//        toast wins, NOT the ceiling toast (guards ordered positivity-first)
//   [G8] non-integer just over the ceiling on a required field -> shared ceiling toast
//   [G9] non-integer just over the ceiling on depositTarget    -> deposit ceiling toast
// WHIT-393: every probe here is derived from LOANFACTS_FIELD_MAX, so changing the ceiling
// needs no edit in this file.
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
import { LOANFACTS_FIELD_MAX } from '../loanLimits';
import { fmtCompact } from '../theme';

// Probes derived from the ceiling. String() is only safe while the ceiling is a safe integer —
// past 2^53 it stops incrementing and from 1e21 it stringifies in exponent form, which would make
// OVER_FRACTION unparseable. The last test in this file pins that precondition.
const AT = String(LOANFACTS_FIELD_MAX);
const OVER = String(LOANFACTS_FIELD_MAX + 1);
const OVER_FRACTION = `${LOANFACTS_FIELD_MAX}.5`;
// The figure is derived; the prose is written out here on purpose, so a reworded toast still has
// to be changed deliberately in both the screen and this file (fmtCompact is pinned by
// format.logic.test.ts, so this is not just asserting the screen against itself).
const AMOUNT_TOAST = `Keep each amount to ${fmtCompact(LOANFACTS_FIELD_MAX)} or less.`;
const DEPOSIT_TOAST = `Keep the deposit target to ${fmtCompact(LOANFACTS_FIELD_MAX)} or less.`;

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

it('[G1] homeValue over the ceiling -> shared toast, no save', async () => {
  const { saveLoanFacts, showToast } = setup();
  render(<Loan />);
  fill({ home: OVER });
  await act(async () => { fireEvent.press(screen.getByText('Save loan details')); });
  expect(showToast).toHaveBeenCalledWith(AMOUNT_TOAST);
  expect(saveLoanFacts).not.toHaveBeenCalled();
});

it('[G2] baseRepay over the ceiling -> shared toast, no save', async () => {
  const { saveLoanFacts, showToast } = setup();
  render(<Loan />);
  fill({ base: OVER });
  await act(async () => { fireEvent.press(screen.getByText('Save loan details')); });
  expect(showToast).toHaveBeenCalledWith(AMOUNT_TOAST);
  expect(saveLoanFacts).not.toHaveBeenCalled();
});

it('[G3] original over the ceiling -> shared toast, no save', async () => {
  const { saveLoanFacts, showToast } = setup();
  render(<Loan />);
  fill({ orig: OVER });
  await act(async () => { fireEvent.press(screen.getByText('Save loan details')); });
  expect(showToast).toHaveBeenCalledWith(AMOUNT_TOAST);
  expect(saveLoanFacts).not.toHaveBeenCalled();
});

// --- Exactly at the ceiling is the strict-> lower boundary: it must SAVE, on non-original fields too ---

it('[G4] homeValue EXACTLY at the ceiling saves (strict >, not just tested on original)', async () => {
  const { saveLoanFacts } = setup();
  render(<Loan />);
  fill({ home: AT });
  await act(async () => { fireEvent.press(screen.getByText('Save loan details')); });
  expect(saveLoanFacts).toHaveBeenCalledWith(expect.objectContaining({ homeValue: LOANFACTS_FIELD_MAX }));
  expect(mockBack).toHaveBeenCalled();
});

it('[G5] extra EXACTLY at the ceiling saves', async () => {
  const { saveLoanFacts } = setup();
  render(<Loan />);
  fill({ extra: AT });
  await act(async () => { fireEvent.press(screen.getByText('Save loan details')); });
  expect(saveLoanFacts).toHaveBeenCalledWith(expect.objectContaining({ extra: LOANFACTS_FIELD_MAX }));
  expect(mockBack).toHaveBeenCalled();
});

it('[G6] depositTarget EXACTLY at the ceiling saves (off-by-one: at passes, +1 blocked by [A8])', async () => {
  const { saveLoanFacts } = setup();
  render(<Loan />);
  fill({ deposit: AT });
  await act(async () => { fireEvent.press(screen.getByText('Save loan details')); });
  expect(saveLoanFacts).toHaveBeenCalledWith(expect.objectContaining({ depositTarget: LOANFACTS_FIELD_MAX }));
  expect(mockBack).toHaveBeenCalled();
});

// --- Precedence: an invalid (empty/zero) required field must win over a ceiling violation ---

it('[G7] a zero required field AND another over ceiling -> the fill toast wins, not the ceiling toast', async () => {
  const { saveLoanFacts, showToast } = setup();
  render(<Loan />);
  // original invalid (0) AND homeValue over ceiling: positivity guard runs first.
  fill({ orig: '0', home: OVER });
  await act(async () => { fireEvent.press(screen.getByText('Save loan details')); });
  expect(showToast).toHaveBeenCalledWith('Please fill in every field with a valid amount.');
  expect(showToast).not.toHaveBeenCalledWith(AMOUNT_TOAST);
  expect(saveLoanFacts).not.toHaveBeenCalled();
});

// --- Non-integer over-ceiling: parseAmount accepts decimals, strict > still catches them ---

it('[G8] a non-integer just over the ceiling on a required field is caught', async () => {
  const { saveLoanFacts, showToast } = setup();
  render(<Loan />);
  fill({ orig: OVER_FRACTION });
  await act(async () => { fireEvent.press(screen.getByText('Save loan details')); });
  expect(showToast).toHaveBeenCalledWith(AMOUNT_TOAST);
  expect(saveLoanFacts).not.toHaveBeenCalled();
});

it('[G9] a non-integer just over the ceiling on depositTarget is caught by its toast', async () => {
  const { saveLoanFacts, showToast } = setup();
  render(<Loan />);
  fill({ deposit: OVER_FRACTION });
  await act(async () => { fireEvent.press(screen.getByText('Save loan details')); });
  expect(showToast).toHaveBeenCalledWith(DEPOSIT_TOAST);
  expect(saveLoanFacts).not.toHaveBeenCalled();
});

// --- The precondition the derived probes above rely on ---

it('the ceiling is a positive safe integer, so the derived probes stay meaningful', () => {
  // Above 2^53 `LOANFACTS_FIELD_MAX + 1` would equal the ceiling and OVER would stop being
  // "over"; from 1e21 String() switches to exponent form and OVER_FRACTION becomes garbage.
  // Either way the tests above would pass vacuously, so pin it here instead.
  expect(Number.isSafeInteger(LOANFACTS_FIELD_MAX)).toBe(true);
  expect(LOANFACTS_FIELD_MAX).toBeGreaterThan(0);
  expect(OVER).toMatch(/^\d+$/);
});
