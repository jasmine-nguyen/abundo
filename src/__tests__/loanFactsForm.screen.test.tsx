// Screen test for the Loan details form (app/loan.tsx): it seeds from saved facts and saves
// them back unchanged, converts LVR percent → fraction on save, calls saveLoanFacts + navigates
// back on success, and blocks an incomplete/invalid/over-ceiling save with a toast (no API call).
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { routerSpies, resetRouter } from './support/routerMock';
import React from 'react';
import { screen, fireEvent, act } from '@testing-library/react-native';
import type { AppContext, LoanFactsInput } from '../context';

// loan.tsx reads saveLoanFacts + showToast off the store; the saved facts come from the real
// useLoanFactsQuery over the fake server's /loanfacts (all-null unless a test seeds it).
type LoanFormState = Pick<AppContext, 'saveLoanFacts' | 'showToast'>;

let mockState: LoanFormState;
jest.mock('../context', () => require('./support/contextMock').realContextWith(() => mockState));
jest.mock('../auth', () => require('./support/authMock').authMockModule());

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import Loan from '../../app/loan';
import { LOANFACTS_FIELD_MAX } from '../loanLimits';
import { fmtCompact } from '../theme';
import { resetAuth } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient, renderLoaded } from './support/renderWithQueries';
import { fillLoanForm, VALID_LOAN_FORM, type LoanFormValues } from './support/loanForm';

const server = installFakeServer();
useTestQueryClient();

// Ceiling-derived probes shared by the WHIT-378 / WHIT-393 gap blocks below (byte-identical in
// both source files, so hoisted once here). Deriving from LOANFACTS_FIELD_MAX means a change to
// the ceiling needs no edit; the toast prose is written out on purpose so a reworded message must
// be changed deliberately in both the screen and this file.
const AT = String(LOANFACTS_FIELD_MAX);
const OVER = String(LOANFACTS_FIELD_MAX + 1);
const DEPOSIT_TOAST = `Keep the deposit target to ${fmtCompact(LOANFACTS_FIELD_MAX)} or less.`;
const AMOUNT_TOAST = `Keep each amount to ${fmtCompact(LOANFACTS_FIELD_MAX)} or less.`;

// Installs a resolving save + a toast spy as the screen's context and hands both back.
function mountSpies() {
  const saveLoanFacts = jest.fn(async (_f: LoanFactsInput) => true);
  const showToast = jest.fn();
  mockState = { saveLoanFacts: saveLoanFacts as AppContext['saveLoanFacts'], showToast: showToast as AppContext['showToast'] };
  return { saveLoanFacts, showToast };
}

const fillValid = () => fillLoanForm(VALID_LOAN_FORM);
const fill = (over: LoanFormValues = {}) => fillLoanForm({ ...VALID_LOAN_FORM, ...over });

beforeEach(() => {
  resetRouter();
  resetAuth();
});

it('saves the facts (LVR as a fraction) and navigates back', async () => {
  const { saveLoanFacts } = mountSpies();
  await renderLoaded(<Loan />);
  fillValid();
  await act(async () => { fireEvent.press(screen.getByText('Save loan details')); });

  // 80% entered → stored as the fraction 0.8; no goal date set → payoffGoalDate null.
  expect(saveLoanFacts).toHaveBeenCalledWith({ original: 600000, homeValue: 770000, lvr: 0.8, ratePct: 5.74, baseRepay: 1240, extra: 200, payoffGoalDate: null, depositTarget: null });
  expect(routerSpies.back).toHaveBeenCalled();
});

it('sends the picked target payoff date, and clears it back to null (WHIT-126)', async () => {
  const { saveLoanFacts } = mountSpies();
  await renderLoaded(<Loan />);
  fillValid();

  // The mock date picker fires a fixed date (2026-06-20) on press.
  await act(async () => { fireEvent.press(screen.getByTestId('mock-datepicker')); });
  expect(screen.getByText('20 Jun 2026')).toBeTruthy();     // label reflects the pick
  await act(async () => { fireEvent.press(screen.getByText('Save loan details')); });
  expect(saveLoanFacts).toHaveBeenCalledWith(expect.objectContaining({ payoffGoalDate: '2026-06-20' }));

  // Clearing it removes the date; the next save carries null again.
  saveLoanFacts.mockClear();
  await act(async () => { fireEvent.press(screen.getByText('Clear')); });
  expect(screen.getByText('Not set')).toBeTruthy();
  await act(async () => { fireEvent.press(screen.getByText('Save loan details')); });
  expect(saveLoanFacts).toHaveBeenCalledWith(expect.objectContaining({ payoffGoalDate: null }));
});

it('sends a typed deposit target as a number (WHIT-378)', async () => {
  const { saveLoanFacts } = mountSpies();
  await renderLoaded(<Loan />);
  fillValid();
  fillLoanForm({ deposit: '120000' });
  await act(async () => { fireEvent.press(screen.getByText('Save loan details')); });
  expect(saveLoanFacts).toHaveBeenCalledWith(expect.objectContaining({ depositTarget: 120000 }));
  // (the blank → null case is already locked by the "saves the facts" test above)
});

it('blocks an incomplete save with a toast and no API call', async () => {
  const { saveLoanFacts, showToast } = mountSpies();
  await renderLoaded(<Loan />);
  // Fill everything except property value → invalid.
  fillLoanForm({ orig: '600000', lvr: '80', rate: '5.74', base: '1240' });
  await act(async () => { fireEvent.press(screen.getByText('Save loan details')); });

  expect(saveLoanFacts).not.toHaveBeenCalled();
  expect(showToast).toHaveBeenCalled();
  expect(routerSpies.back).not.toHaveBeenCalled();
});

// ===== WHIT-378 (folded from loanDepositTargetGaps.screen.test.tsx) =====
// GAP coverage for the deposit-target guard + clear. Same harness (identical context /
// expo-router mocks and fake server, same state / fillValid), so these run at module scope. Adds the paths
// the survivor skips: the DEPOSIT-SPECIFIC toast on garbage / zero, the ceiling toast on over-max,
// and the EDIT clear-to-null flow.
describe('WHIT-378 deposit-target guard + clear (gaps)', () => {
  it('[A6] garbage deposit target (all six fields valid) is blocked by the target toast, no save', async () => {
    const { saveLoanFacts, showToast } = mountSpies();
    await renderLoaded(<Loan />);
    fillValid();
    fillLoanForm({ deposit: '12abc' });
    await act(async () => { fireEvent.press(screen.getByText('Save loan details')); });

    // The six-field guard passes, so it's the DEPOSIT-specific message that fires...
    expect(showToast).toHaveBeenCalledWith('Enter a valid deposit target, or leave it blank.');
    // ...and nothing is persisted or navigated. Fail-on-revert: drop the app/loan.tsx:63 guard
    // and NaN sails through to saveLoanFacts.
    expect(saveLoanFacts).not.toHaveBeenCalled();
    expect(routerSpies.back).not.toHaveBeenCalled();
  });

  it('[A8] a deposit target over the ceiling is blocked by its own toast, no save', async () => {
    const { saveLoanFacts, showToast } = mountSpies();
    await renderLoaded(<Loan />);
    fillValid();
    fillLoanForm({ deposit: OVER });
    await act(async () => { fireEvent.press(screen.getByText('Save loan details')); });
    // Distinct from the finite/>0 toast — this is the ceiling message. Fail-on-revert: drop the
    // deposit-target ceiling guard and an over-ceiling value sails through to saveLoanFacts.
    expect(showToast).toHaveBeenCalledWith(DEPOSIT_TOAST);
    expect(saveLoanFacts).not.toHaveBeenCalled();
    expect(routerSpies.back).not.toHaveBeenCalled();
  });

  it('[A7] EDIT: a seeded target cleared to blank saves depositTarget:null (no stale value)', async () => {
    server.seed('/loanfacts', { original: 600000, homeValue: 770000, lvr: 0.8, ratePct: 5.74, baseRepay: 1240, extra: 200, depositTarget: 120000 });
    const { saveLoanFacts } = mountSpies();
    await renderLoaded(<Loan />);
    expect(screen.getByDisplayValue('120000')).toBeTruthy();   // seeded
    fireEvent.changeText(screen.getByDisplayValue('120000'), '');  // user clears it
    await act(async () => { fireEvent.press(screen.getByText('Save loan details')); });
    expect(saveLoanFacts).toHaveBeenCalledWith(expect.objectContaining({ depositTarget: null }));
  });
});

describe('saved facts round trip', () => {
  it('user sees their saved loan facts prefilled and can save them unchanged', async () => {
    const SAVED = {
      original: 600000, homeValue: 770000, lvr: 0.5, ratePct: 5.74,
      baseRepay: 1240, extra: 200, payoffGoalDate: null, depositTarget: null,
    };
    server.seed('/loanfacts', SAVED);
    const { saveLoanFacts } = mountSpies();

    await renderLoaded(<Loan />);

    expect(screen.getByDisplayValue('600000')).toBeTruthy();
    expect(screen.getByDisplayValue('770000')).toBeTruthy();
    expect(screen.getByDisplayValue('50')).toBeTruthy();
    expect(screen.getByDisplayValue('5.74')).toBeTruthy();
    expect(screen.getByDisplayValue('1240')).toBeTruthy();
    expect(screen.getByDisplayValue('200')).toBeTruthy();

    await act(async () => { fireEvent.press(screen.getByText('Save loan details')); });

    expect(saveLoanFacts).toHaveBeenCalledWith(SAVED);
    expect(routerSpies.back).toHaveBeenCalled();
  });

  // WHIT-126: a stale-seed bug would silently wipe an already-saved payoff goal date.
  it('preserves the saved goal date on a save that never opens the picker', async () => {
    server.seed('/loanfacts', { original: 600000, homeValue: 770000, lvr: 0.8, ratePct: 5.74, baseRepay: 1240, extra: 200, payoffGoalDate: '2035-06-01' });
    const { saveLoanFacts } = mountSpies();
    await renderLoaded(<Loan />);
    await act(async () => { fireEvent.press(screen.getByText('Save loan details')); });
    expect(saveLoanFacts).toHaveBeenCalledWith(expect.objectContaining({ payoffGoalDate: '2035-06-01' }));
    expect(routerSpies.back).toHaveBeenCalled();
  });
});

// Client-guard boundaries: extra == 0 allowed, lvr/ratePct at their exact upper bounds allowed,
// lvr == 0 blocked, trailing garbage rejected, and the dollar ceiling (strict >, matching the server).
describe('client-guard boundaries', () => {
  it('accepts Extra = 0 (optional top-up) and saves', async () => {
    const { saveLoanFacts } = mountSpies();
    await renderLoaded(<Loan />);
    fill({ extra: '0' });
    await act(async () => { fireEvent.press(screen.getByText('Save loan details')); });
    expect(saveLoanFacts).toHaveBeenCalledWith(expect.objectContaining({ extra: 0 }));
    expect(routerSpies.back).toHaveBeenCalled();
  });

  it('accepts the exact upper bounds LVR = 100% and rate = 100', async () => {
    const { saveLoanFacts } = mountSpies();
    await renderLoaded(<Loan />);
    fill({ lvr: '100', rate: '100' });   // client guard is lvr<=1 (fraction) and ratePct<=100
    await act(async () => { fireEvent.press(screen.getByText('Save loan details')); });
    expect(saveLoanFacts).toHaveBeenCalledWith(expect.objectContaining({ lvr: 1, ratePct: 100 }));
  });

  it('blocks LVR = 0 (must be > 0) with a toast and no save', async () => {
    const { saveLoanFacts, showToast } = mountSpies();
    await renderLoaded(<Loan />);
    fill({ lvr: '0' });
    await act(async () => { fireEvent.press(screen.getByText('Save loan details')); });
    expect(saveLoanFacts).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalled();
  });

  it('rejects trailing garbage in a number ("80abc") rather than storing 80', async () => {
    const { saveLoanFacts, showToast } = mountSpies();
    await renderLoaded(<Loan />);
    fill({ home: '770000abc' });   // paste can slip past the decimal-pad keyboard
    await act(async () => { fireEvent.press(screen.getByText('Save loan details')); });
    expect(saveLoanFacts).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalled();
  });

  it('blocks a dollar field over the ceiling (extra) with a toast and no save', async () => {
    const { saveLoanFacts, showToast } = mountSpies();
    await renderLoaded(<Loan />);
    // A non-first field over the ceiling — proves the .some() check catches more than original.
    fill({ extra: OVER });
    await act(async () => { fireEvent.press(screen.getByText('Save loan details')); });
    expect(saveLoanFacts).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(AMOUNT_TOAST);
  });

  it('accepts exactly the ceiling (strict >, matching the server) and saves', async () => {
    const { saveLoanFacts } = mountSpies();
    await renderLoaded(<Loan />);
    fill({ orig: AT });
    await act(async () => { fireEvent.press(screen.getByText('Save loan details')); });
    expect(saveLoanFacts).toHaveBeenCalledWith(expect.objectContaining({ original: LOANFACTS_FIELD_MAX }));
    expect(routerSpies.back).toHaveBeenCalled();
  });
});

// WHIT-393: is the ceiling toast the user sees honest about the ceiling? AMOUNT_TOAST above is
// built with the screen's own fmtCompact, so its FIGURE is never independently checked. This test
// takes the string the screen really emitted, parses the dollar figure back out, and compares it to
// LOANFACTS_FIELD_MAX — which closes the loop for any ceiling.
describe('the ceiling toast tells the truth about the ceiling', () => {
  // Read the dollar figure back OUT of a rendered sentence. This PARSES the label; it does not
  // re-implement the formatter, so it can't agree with a wrong formatter by construction.
  // "$1B" -> 1e9, "$1.5B" -> 1.5e9, "$500M" -> 5e8, "$900,000" -> 900000.
  function dollarsNamedIn(sentence: string): number {
    const token = /\$[\d,]+(?:\.\d+)?[BM]?/.exec(sentence);
    expect(token).not.toBeNull();
    const match = /^\$([\d,]+(?:\.\d+)?)([BM]?)$/.exec(token![0])!;
    const unit = match[2] === 'B' ? 1_000_000_000 : match[2] === 'M' ? 1_000_000 : 1;
    // Rounded because the multiply is not exact for every tenth — Number('4.1') * 1e9 lands on
    // 4100000000.0000005, which would fail the exact comparison at a $4.1B ceiling.
    return Math.round(Number(match[1].replace(/,/g, '')) * unit);
  }

  // Trigger the amounts ceiling toast and hand back the exact string the screen passed to showToast.
  async function amountCeilingToast(): Promise<string> {
    const { saveLoanFacts, showToast } = mountSpies();
    await renderLoaded(<Loan />);
    fill({ deposit: '', home: OVER });
    fireEvent.press(screen.getByText('Save loan details'));
    expect(saveLoanFacts).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledTimes(1);
    return String(showToast.mock.calls[0][0]);
  }

  it('[C1] the amounts toast names the ceiling EXACTLY', async () => {
    // "or less" is an inclusive promise, so the figure has to be the actual bound. Naming less
    // is safe but wrong; naming MORE sends the user round a loop. Exact equality catches both.
    expect(dollarsNamedIn(await amountCeilingToast())).toBe(LOANFACTS_FIELD_MAX);
  });
});
