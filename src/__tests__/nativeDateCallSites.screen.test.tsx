// WHIT-255/256 — INTEGRATION gaps at the real date call-sites. The implementer tested
// NativeDateField in isolation (pill gate, min/max forwarding) and the existing goalEdit /
// loanFactsForm / goalBalanceSheet / PayCycleSheet suites cover the commit/save paths. What
// NOTHING guards is that each SCREEN passes the RIGHT props to the shared field — the one thing
// the refactor could silently break while every isolation test stays green:
//   - goal TARGET DATE must NOT get alwaysShowPillIOS → an empty REQUIRED field shows the "Set
//     date" affordance, never a pre-filled "tomorrow" pill that reads as already-set.
//   - loan payoff DOES get alwaysShowPillIOS → an unset optional field still shows the pill.
//   - goal AS OF forwards maximumDate (can't be future); TARGET DATE forwards minimumDate
//     (can't be today/past). A dropped constraint at the call-site would let the picker offer
//     illegal days with no isolation test catching it.
//
// Platform is PINNED to iOS per test (not left to the per-worker RN default) so the pill-gate
// assertions are deterministic. The global datetimepicker mock is overridden to CAPTURE props.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { Platform } from 'react-native';
import { render, screen, fireEvent } from '@testing-library/react-native';
import type { GoalRecord, AccountBalance } from '../api';

// Capture every props object the picker is rendered with, across re-renders.
let mockPickerProps: Array<Record<string, unknown>> = [];
jest.mock('@react-native-community/datetimepicker', () => {
  const ReactLib = require('react');
  const { Pressable, Text } = require('react-native');
  const MockPicker = (props: any) => {
    mockPickerProps.push(props);
    return ReactLib.createElement(
      Pressable,
      { testID: 'mock-datepicker', onPress: () => props.onChange && props.onChange({ type: 'set' }, new Date(2026, 5, 20)) },
      ReactLib.createElement(Text, null, 'picker'),
    );
  };
  return { __esModule: true, default: MockPicker };
});

// ---- shared boundary mocks (both screens live behind these) ----
const mockAppCtx = { saveGoal: jest.fn(async () => true), deleteGoal: jest.fn(async () => true), saveLoanFacts: jest.fn(async () => true), showToast: jest.fn() };
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockAppCtx };
});

let mockGoals: GoalRecord[];
let mockBalances: Map<string, AccountBalance>;
jest.mock('../queries', () => ({
  useIsAuthed: () => true,
  useGoalsQuery: () => ({ data: mockGoals }),
  useTransactionsScreenData: () => ({ transactions: [{ account_id: 'acc-1', account_name: 'Everyday' }], balances: mockBalances }),
  useLoanFactsQuery: () => ({ data: undefined }), // → EMPTY_LOAN_FACTS: every field unset, payoff null
}));

let mockParams: { id?: string };
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({ back: jest.fn(), push: jest.fn() }),
}));

import GoalEdit from '../../app/goal/edit';
import Loan from '../../app/loan';

const ORIGINAL_OS = Platform.OS;

beforeEach(() => {
  mockPickerProps = [];
  mockParams = {};
  mockGoals = [];
  mockBalances = new Map([['acc-1', { account_id: 'acc-1', amount: 2500, available_balance: null, currency: 'AUD', as_of: '2026-07-01', account_type: 'savings' }]]);
  Platform.OS = 'ios' as typeof Platform.OS;
});
afterEach(() => { Platform.OS = ORIGINAL_OS; });

describe('the iOS pill gate is wired correctly at each call-site', () => {
  // [Q1] goal TARGET DATE — unset + iOS → the "Set date" affordance, NOT a pre-filled pill. If a
  // refactor passed alwaysShowPillIOS here, an empty REQUIRED field would show a "tomorrow" pill
  // that reads as already-set. goalEdit's setTargetDate() TOLERATES either variant, so only this
  // asserts the affordance is present.
  it('[Q1] goal edit: an unset TARGET DATE shows "Set date", never an inline pill', () => {
    render(<GoalEdit />);
    // create form, source unchosen → AS OF hidden, so TARGET is the only date field.
    expect(screen.getByTestId('date-open')).toBeTruthy();
    expect(screen.getByText('Set date')).toBeTruthy();
    expect(screen.queryByTestId('mock-datepicker')).toBeNull();
  });

  // [Q2] loan payoff — unset + iOS → the inline pill (alwaysShowPillIOS), NOT a "Set date"
  // affordance. loanFactsForm implicitly relies on this (it taps mock-datepicker directly) but
  // conflates it with the save; this pins it explicitly on iOS.
  it('[Q2] loan: an unset payoff date shows the inline pill (alwaysShowPillIOS)', () => {
    render(<Loan />);
    expect(screen.getByTestId('mock-datepicker')).toBeTruthy();
    expect(screen.queryByTestId('date-open')).toBeNull();
  });
});

describe('the goal call-sites forward their date constraints', () => {
  // [Q3] AS OF must cap at today (maximumDate, no minimumDate); TARGET DATE must floor at tomorrow
  // (minimumDate, no maximumDate). Drop either at the JSX call-site and the picker would offer
  // illegal days — the isolation forwarding test can't catch a call-site that stops passing them.
  it('[Q3] AS OF picker gets maximumDate only; TARGET DATE picker gets minimumDate only', () => {
    render(<GoalEdit />);
    fireEvent.press(screen.getByTestId('goal-source-manual')); // reveal AS OF (seeded today → iOS pill mounts)
    // AS OF: a value is set → its pill is inline with maximumDate (today) and no minimumDate.
    expect(mockPickerProps.some((p) => p.maximumDate != null && p.minimumDate == null)).toBe(true);

    // Open the still-unset TARGET DATE so its pill mounts, then assert the opposite constraint.
    fireEvent.press(screen.getByTestId('date-open'));
    expect(mockPickerProps.some((p) => p.minimumDate != null && p.maximumDate == null)).toBe(true);
  });
});
