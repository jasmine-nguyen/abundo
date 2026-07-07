// Screen tests for the Home Loan Milestone screen (WHIT-8) and its entry point.
// WHIT-197: the live balance / loan facts / repayment now come from the cached query
// layer via useGoalScreenData(), so that hook is mocked (the real milestoneView /
// goalView selectors still run over the mocked composite data). ../context stays
// partially mocked for the real selectors + the minimal useAppContext the Goal tab
// keeps for s.fireRepayment. expo-router's useRouter is mocked to capture navigation.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { makeGoalData, EMPTY_LOAN_FACTS } from './factory';
import type { GoalScreenData } from '../queries';

// The composite the two screens now read (makeGoalData is typed off the real
// GoalScreenData). `homeLoanError` is the balance read's OWN error, kept separate from
// the aggregate isError (a repayment/loanFacts failure must not masquerade as a balance
// error).
let mockGoal: GoalScreenData;
jest.mock('../queries', () => ({ useGoalScreenData: () => mockGoal }));

// useAppContext is now only read by the Goal tab, for s.fireRepayment.
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ fireRepayment: jest.fn() }) };
});

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn() }),
  useFocusEffect: () => {},
}));

import Milestone from '../../app/milestone';
import Goals from '../../app/(tabs)/goals';

// Loan facts are saved by default (property value + LVR set) so equity renders; pass
// EMPTY_LOAN_FACTS to exercise the "set this up" empty state.
beforeEach(() => {
  mockPush.mockClear();
  mockGoal = makeGoalData();
});

// --- the milestone screen ----------------------------------------------------

it('renders the live balance, the sprint plan, and usable equity', () => {
  mockGoal = makeGoalData({ homeLoan: { balance: 596642.43, asOf: '2026-07-04T00:24:37.614Z' } });
  render(<Milestone />);
  expect(screen.getByText('$596,642')).toBeTruthy();       // hero balance
  expect(screen.getByText('The 36-month plan')).toBeTruthy();
  expect(screen.getByText('Investment property #2')).toBeTruthy();
  // Sprint 0 is the next milestone at this balance, so its callout shows.
  expect(screen.getByText('under $544,000')).toBeTruthy();
});

it('shows a waiting state before the live balance has loaded', () => {
  mockGoal = makeGoalData({ homeLoan: { balance: null, asOf: null } });
  render(<Milestone />);
  expect(screen.getByText('Fetching your live balance…')).toBeTruthy();
  // No fabricated balance while unknown.
  expect(screen.queryByText(/milestones reached/)).toBeNull();
});

it('shows an error + retry (not a permanent spinner) when the balance fetch failed', () => {
  const refetch = jest.fn();
  mockGoal = makeGoalData({ homeLoan: { balance: null, asOf: null }, homeLoanError: true, isError: true, refetch });
  render(<Milestone />);
  // Distinct from the waiting spinner — an honest failure message.
  expect(screen.getByText("Couldn't load your balance.")).toBeTruthy();
  expect(screen.queryByText('Fetching your live balance…')).toBeNull();
  // WHIT-121 #4 parity: the milestone Retry now carries the same a11y contract as the Goal-tab
  // ones (shared RetryButton). Assert the props so a regression on this copy is caught too.
  const retry = screen.getByTestId('milestone-balance-retry');
  expect(retry.props.accessibilityRole).toBe('button');
  expect(retry.props.accessibilityLabel).toBe('Retry loading your balance');
  expect(screen.getByText("Couldn't load your balance.").props.accessibilityLiveRegion).toBe('polite');
  fireEvent.press(retry);
  expect(refetch).toHaveBeenCalled();
});

it('does NOT show a balance error when only repayment/loanFacts failed (balance still loading)', () => {
  // The aggregate isError is true, but the balance read itself is fine (homeLoanError
  // false) — the hero must show the spinner, not "Couldn't load your balance". Locks
  // the home-loan-scoped error (plan-critic #1): reverting milestone.tsx to key on the
  // aggregate isError turns this red.
  mockGoal = makeGoalData({ homeLoan: { balance: null, asOf: null }, homeLoanError: false, isError: true });
  render(<Milestone />);
  expect(screen.getByText('Fetching your live balance…')).toBeTruthy();
  expect(screen.queryByText("Couldn't load your balance.")).toBeNull();
});

// --- the Goal-tab entry point ------------------------------------------------

it('navigates to /milestone from the Goal-tab Sprint summary', () => {
  render(<Goals />);
  fireEvent.press(screen.getByTestId('milestone-link'));
  expect(mockPush).toHaveBeenCalledWith('/milestone');
});

it('Goal-tab Sprint summary shows real progress when the balance has loaded', () => {
  mockGoal = makeGoalData({ homeLoan: { balance: 596642.43, asOf: '2026-07-04T00:24:37.614Z' } });
  render(<Goals />);
  // Real Sprint model (from the live balance), not the old $50k chunks.
  expect(screen.getByText('0 of 5 sprints reached')).toBeTruthy();
  expect(screen.getByText('Next: under $544,000')).toBeTruthy();
  expect(screen.queryByText(/chunks cleared/)).toBeNull();
});

it('Goal-tab Sprint summary invites a tap before the balance loads', () => {
  render(<Goals />);
  expect(screen.getByText('The 36-month plan')).toBeTruthy();
  expect(screen.getByText('Tap to see your live progress')).toBeTruthy();
});

it('Goal tab shows a balance error + Retry when the balance read fails (WHIT-121 #2)', () => {
  // WHIT-121 (#2): with loan facts SET, a homeLoan failure now surfaces an error + Retry on
  // the Goal hero instead of silently degrading to "—" — the Goal tab previously swallowed a
  // balance failure. Mirrors milestone.tsx. The projection stays hidden (no fake numbers).
  const refetch = jest.fn();
  mockGoal = makeGoalData({ homeLoan: { balance: null, asOf: null }, homeLoanError: true, isError: true, refetch });
  render(<Goals />);
  expect(screen.getByText("Couldn't load your balance.")).toBeTruthy();
  expect(screen.queryByText('Mortgage-free')).toBeNull();
  fireEvent.press(screen.getByTestId('hero-balance-retry'));
  expect(refetch).toHaveBeenCalledTimes(1);
});

// --- empty state (loan facts not set) ----------------------------------------

it('Goal tab shows a set-up prompt (not fake numbers) when loan facts are unset', () => {
  mockGoal = makeGoalData({ loanFacts: EMPTY_LOAN_FACTS, homeLoan: { balance: 596642.43, asOf: '2026-07-04T00:24:37.614Z' } });
  render(<Goals />);
  // The real live balance still shows; the fake "$67,100 whittled" seed does not.
  expect(screen.getByText('$596,642')).toBeTruthy();
  expect(screen.getByText('Set up loan details →')).toBeTruthy();
  expect(screen.queryByText(/whittled so far/i)).toBeNull();
  expect(screen.queryByText('Mortgage-free')).toBeNull();  // seed projection hidden until set up
});

it('milestone screen shows an equity set-up prompt when the property value is unset', () => {
  mockGoal = makeGoalData({ loanFacts: EMPTY_LOAN_FACTS, homeLoan: { balance: 596642.43, asOf: '2026-07-04T00:24:37.614Z' } });
  render(<Milestone />);
  // Balance + sprint plan still render (they only need the live balance)...
  expect(screen.getByText('$596,642')).toBeTruthy();
  expect(screen.getByText('The 36-month plan')).toBeTruthy();
  // ...but equity is a prompt, not a fabricated figure.
  expect(screen.getByText(/Add your property value/)).toBeTruthy();
  fireEvent.press(screen.getByText('Add loan details →'));
  expect(mockPush).toHaveBeenCalledWith('/loan');
});

// --- Goal-tab last-repayment card (WHIT-115) ---------------------------------

it('Goal tab shows the real last repayment (amount + date + split), no fake timestamp', () => {
  mockGoal = makeGoalData({
    // A distinct amount (not 1440) so it doesn't collide with the contribution
    // card's "$1,440" (baseRepay 1240 + extra 200) now the leading "−" is gone.
    repayment: { amount: 1500, date: '2026-07-01', principal: 1268, interest: 232 },
  });
  render(<Goals />);
  expect(screen.getByText(/Last repayment ·/)).toBeTruthy();
  expect(screen.getByText('$1,268 principal · $232 interest')).toBeTruthy();
  expect(screen.getByText('$1,500')).toBeTruthy();   // plain positive — a repayment toward the goal, not a debit
  // The old hardcoded seed timestamp must be gone.
  expect(screen.queryByText(/9:02am/)).toBeNull();
});

it('Goal tab shows a graceful empty state when there is no repayment on record', () => {
  mockGoal = makeGoalData({ repayment: { amount: null, date: null, principal: null, interest: null } });
  render(<Goals />);
  expect(screen.getByText(/No repayment on record yet/)).toBeTruthy();
});
