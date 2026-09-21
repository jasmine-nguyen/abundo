// Screen test for the Loan details form (app/loan.tsx): it seeds from saved facts,
// converts LVR percent → fraction on save, calls saveLoanFacts + navigates back on
// success, and blocks an incomplete/invalid save with a toast (no API call).
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react-native';
import { ScrollView } from 'react-native';
import type { AppContext, LoanFacts, LoanFactsInput } from '../context';

// WHIT-192: loan.tsx reads saveLoanFacts + showToast off the store; the saved facts come
// from useLoanFactsQuery (query layer, re-routed via screenQueryMocks). The fixture carries
// those writers PLUS loanFacts purely to feed that query mock.
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

// Ceiling-derived probes shared by the WHIT-378 / WHIT-393 gap blocks below (byte-identical in
// both source files, so hoisted once here). Deriving from LOANFACTS_FIELD_MAX means a change to
// the ceiling needs no edit; the toast prose is written out on purpose so a reworded message must
// be changed deliberately in both the screen and this file.
const OVER = String(LOANFACTS_FIELD_MAX + 1);
const DEPOSIT_TOAST = `Keep the deposit target to ${fmtCompact(LOANFACTS_FIELD_MAX)} or less.`;

const EMPTY: LoanFacts = { original: null, homeValue: null, lvr: null, ratePct: null, baseRepay: null, extra: null };

function state(over: Partial<LoanFormState>): LoanFormState {
  return { loanFacts: EMPTY, saveLoanFacts: jest.fn() as LoanFormState['saveLoanFacts'], showToast: jest.fn() as AppContext['showToast'], ...over };
}

function fillValid() {
  fireEvent.changeText(screen.getByPlaceholderText('e.g. 600000'), '600000');
  fireEvent.changeText(screen.getByPlaceholderText('e.g. 770000'), '770000');
  fireEvent.changeText(screen.getByPlaceholderText('e.g. 80'), '80');       // LVR percent
  fireEvent.changeText(screen.getByPlaceholderText('e.g. 5.74'), '5.74');
  fireEvent.changeText(screen.getByPlaceholderText('e.g. 3667'), '1240');
  fireEvent.changeText(screen.getByPlaceholderText('e.g. 500'), '200');
}

beforeEach(() => {
  mockBack.mockClear();
});

it('saves the facts (LVR as a fraction) and navigates back', async () => {
  const saveLoanFacts = jest.fn(async (_f: LoanFactsInput) => true);
  mockState = state({ saveLoanFacts: saveLoanFacts as AppContext['saveLoanFacts'] });
  render(<Loan />);
  fillValid();
  await act(async () => { fireEvent.press(screen.getByText('Save loan details')); });

  // 80% entered → stored as the fraction 0.8; no goal date set → payoffGoalDate null.
  expect(saveLoanFacts).toHaveBeenCalledWith({ original: 600000, homeValue: 770000, lvr: 0.8, ratePct: 5.74, baseRepay: 1240, extra: 200, payoffGoalDate: null, depositTarget: null });
  expect(mockBack).toHaveBeenCalled();
});

it('sends the picked target payoff date, and clears it back to null (WHIT-126)', async () => {
  const saveLoanFacts = jest.fn(async (_f: LoanFactsInput) => true);
  mockState = state({ saveLoanFacts: saveLoanFacts as AppContext['saveLoanFacts'] });
  render(<Loan />);
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
  const saveLoanFacts = jest.fn(async (_f: LoanFactsInput) => true);
  mockState = state({ saveLoanFacts: saveLoanFacts as AppContext['saveLoanFacts'] });
  render(<Loan />);
  fillValid();
  fireEvent.changeText(screen.getByPlaceholderText('e.g. 120000'), '120000');
  await act(async () => { fireEvent.press(screen.getByText('Save loan details')); });
  expect(saveLoanFacts).toHaveBeenCalledWith(expect.objectContaining({ depositTarget: 120000 }));
  // (the blank → null case is already locked by the "saves the facts" test above)
});

it('seeds the deposit target from already-saved facts (WHIT-378)', () => {
  mockState = state({ loanFacts: { original: 500000, homeValue: 770000, lvr: 0.8, ratePct: 5.74, baseRepay: 1240, extra: 200, depositTarget: 120000 } });
  render(<Loan />);
  expect(screen.getByDisplayValue('120000')).toBeTruthy();
});

it('blocks an incomplete save with a toast and no API call', async () => {
  const saveLoanFacts = jest.fn(async (_f: LoanFactsInput) => true);
  const showToast = jest.fn();
  mockState = state({ saveLoanFacts: saveLoanFacts as AppContext['saveLoanFacts'], showToast: showToast as AppContext['showToast'] });
  render(<Loan />);
  // Fill everything except property value → invalid.
  fireEvent.changeText(screen.getByPlaceholderText('e.g. 600000'), '600000');
  fireEvent.changeText(screen.getByPlaceholderText('e.g. 80'), '80');
  fireEvent.changeText(screen.getByPlaceholderText('e.g. 5.74'), '5.74');
  fireEvent.changeText(screen.getByPlaceholderText('e.g. 3667'), '1240');
  await act(async () => { fireEvent.press(screen.getByText('Save loan details')); });

  expect(saveLoanFacts).not.toHaveBeenCalled();
  expect(showToast).toHaveBeenCalled();
  expect(mockBack).not.toHaveBeenCalled();
});

it('seeds inputs from already-saved facts (LVR shown as a percent)', () => {
  mockState = state({ loanFacts: { original: 500000, homeValue: 770000, lvr: 0.8, ratePct: 5.74, baseRepay: 1240, extra: 200 } });
  render(<Loan />);
  // 0.8 fraction is shown as "80" in the percent field.
  expect(screen.getByDisplayValue('80')).toBeTruthy();
  expect(screen.getByDisplayValue('770000')).toBeTruthy();
});

// The Save button sits below the fields, so the keyboard opens over it. The form scroll must
// inset for the keyboard AND keep taps alive. Fail-on-revert: drop the props in app/loan.tsx →
// find() returns undefined.
it('wraps the form in a keyboard-inset, tap-persisting scroll so Save stays reachable', () => {
  mockState = state({});
  const { UNSAFE_getAllByType } = render(<Loan />);
  const formScroll = UNSAFE_getAllByType(ScrollView).find(
    (sv) => sv.props.automaticallyAdjustKeyboardInsets === true && sv.props.keyboardShouldPersistTaps === 'handled',
  );
  expect(formScroll).toBeTruthy();
  // Save must live INSIDE that insetted scroll — that's what keeps it reachable over the keyboard.
  expect(formScroll!.findAll((n) => n === screen.getByText('Save loan details'))).toHaveLength(1);
});

// ===== WHIT-378 (folded from loanDepositTargetGaps.screen.test.tsx) =====
// GAP coverage for the deposit-target guard + clear. Same harness (identical context / queries /
// expo-router mocks, same EMPTY / state / fillValid), so these run at module scope. Adds the paths
// the survivor skips: the DEPOSIT-SPECIFIC toast on garbage / zero, the ceiling toast on over-max,
// and the EDIT clear-to-null flow.
describe('WHIT-378 deposit-target guard + clear (gaps)', () => {
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
});

// ===== WHIT-382 (folded from loanFactsCeilingGaps.screen.test.tsx) =====
// GAP coverage for the loan form's dollar-ceiling guards. This block carries its OWN fill()/setup()
// helpers and AT / OVER_FRACTION / AMOUNT_TOAST probes (they diverge from the survivor's fillValid),
// block-scoped so neither regime is weakened; it reuses the module-level state / OVER / DEPOSIT_TOAST.
// Every probe is derived from LOANFACTS_FIELD_MAX, so changing the ceiling needs no edit here.
describe('WHIT-382 dollar-ceiling guards (gaps)', () => {
  const AT = String(LOANFACTS_FIELD_MAX);
  const OVER_FRACTION = `${LOANFACTS_FIELD_MAX}.5`;
  // The figure is derived; the prose is written out here on purpose, so a reworded toast still has
  // to be changed deliberately in both the screen and this file (fmtCompact is pinned by
  // format.logic.test.ts, so this is not just asserting the screen against itself).
  const AMOUNT_TOAST = `Keep each amount to ${fmtCompact(LOANFACTS_FIELD_MAX)} or less.`;

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
});
