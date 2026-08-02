// WHIT-393 — [C1]-[C5]: is the ceiling toast the user actually sees HONEST about the ceiling?
//
// Why this file exists. Every other loan-form suite now builds its expected toast with the same
// fmtCompact the screen uses, so the FIGURE in the message is never independently checked — flip
// the ceiling to 1_250_000_000 and the screen says "Keep each amount to $1.3B or less" while the
// server rejects anything over $1.25B, and the whole suite stays green. These tests never call
// fmtCompact: they take the toast string the screen really emitted, parse the dollar figure back
// out of it, and compare that number to LOANFACTS_FIELD_MAX. That closes the loop for any
// ceiling, not just the 1e9 pinned literally in format.logic.test.ts.
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

import Loan, { LOANFACTS_FIELD_MAX } from '../../app/loan';

const EMPTY: LoanFacts = { original: null, homeValue: null, lvr: null, ratePct: null, baseRepay: null, extra: null };

function state(over: Partial<AppContext>): AppContext {
  return { loanFacts: EMPTY, saveLoanFacts: jest.fn(), showToast: jest.fn(), ...over } as unknown as AppContext;
}

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

// Read the dollar figure back OUT of a rendered sentence. This PARSES the label; it does not
// re-implement the formatter, so it can't agree with a wrong formatter by construction.
// "$1B" -> 1e9, "$1.5B" -> 1.5e9, "$500M" -> 5e8, "$900,000" -> 900000.
function dollarsNamedIn(sentence: string): number {
  const token = /\$[\d,]+(?:\.\d+)?[BM]?/.exec(sentence);
  expect(token).not.toBeNull();
  const match = /^\$([\d,]+(?:\.\d+)?)([BM]?)$/.exec(token![0])!;
  const unit = match[2] === 'B' ? 1_000_000_000 : match[2] === 'M' ? 1_000_000 : 1;
  return Number(match[1].replace(/,/g, '')) * unit;
}

// Trigger each ceiling toast and hand back the exact string the screen passed to showToast.
function amountCeilingToast(): string {
  const { showToast, saveLoanFacts } = setup();
  render(<Loan />);
  fill({ home: String(LOANFACTS_FIELD_MAX + 1) });
  fireEvent.press(screen.getByText('Save loan details'));
  expect(saveLoanFacts).not.toHaveBeenCalled();
  expect(showToast).toHaveBeenCalledTimes(1);
  return String((showToast as jest.Mock).mock.calls[0][0]);
}

function depositCeilingToast(): string {
  const { showToast, saveLoanFacts } = setup();
  render(<Loan />);
  fill({ deposit: String(LOANFACTS_FIELD_MAX + 1) });
  fireEvent.press(screen.getByText('Save loan details'));
  expect(saveLoanFacts).not.toHaveBeenCalled();
  expect(showToast).toHaveBeenCalledTimes(1);
  return String((showToast as jest.Mock).mock.calls[0][0]);
}

beforeEach(() => { mockBack.mockClear(); });

describe('the ceiling toast tells the truth about the ceiling', () => {
  it('[C1] the amounts toast never names a figure ABOVE the real ceiling', () => {
    // The harmful direction: naming more than the guard allows sends the user round a loop —
    // they retype the figure the message told them to and get the same message back.
    expect(dollarsNamedIn(amountCeilingToast())).toBeLessThanOrEqual(LOANFACTS_FIELD_MAX);
  });

  it('[C2] the amounts toast names the ceiling EXACTLY', () => {
    // "or less" is an inclusive promise, so the figure has to be the actual bound. Naming
    // less is safe but wrong; naming more is [C1]. Both are caught here.
    expect(dollarsNamedIn(amountCeilingToast())).toBe(LOANFACTS_FIELD_MAX);
  });

  it('[C3] the deposit-target toast names the ceiling EXACTLY too', () => {
    expect(dollarsNamedIn(depositCeilingToast())).toBe(LOANFACTS_FIELD_MAX);
  });
});

describe('the corrected wording (WHIT-393)', () => {
  // The guard is strict `>`, so exactly the ceiling is ACCEPTED (locked by [G4]-[G6]). The old
  // copy said "under $1B", which was wrong by a dollar. These lock the fix so it can't drift
  // back, independently of the figure.
  it('[C4] the amounts toast says "or less", never "under"', () => {
    const toast = amountCeilingToast();
    expect(toast).toContain('or less');
    expect(toast).not.toMatch(/\bunder\b/i);
  });

  it('[C5] the deposit-target toast says "or less", never "under"', () => {
    const toast = depositCeilingToast();
    expect(toast).toContain('or less');
    expect(toast).not.toMatch(/\bunder\b/i);
  });
});
