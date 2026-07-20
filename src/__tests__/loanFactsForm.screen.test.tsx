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
  expect(saveLoanFacts).toHaveBeenCalledWith({ original: 600000, homeValue: 770000, lvr: 0.8, ratePct: 5.74, baseRepay: 1240, extra: 200, payoffGoalDate: null });
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
