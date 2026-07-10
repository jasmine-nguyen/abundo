// WHIT-114 — GAP screen tests for the Goal-tab payoff mini-cards. There is no
// existing screen test for paydownView's rendering; this locks that each `mode`
// draws the RIGHT card (and that the retired seed values are gone). The real
// paydownView selector runs over injected state (jest.mock keeps the actual
// module, overriding only useAppContext), so these fail if the selector reverts.
//
// The clock is pinned to 2026-07-04 because goals.tsx calls paydownView(s) with
// no injected `today` (it uses new Date()); pinning makes the projected month-year
// deterministic instead of drifting with the wall clock.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { makeGoalData } from './factory';
import type { GoalScreenData } from '../queries';

// WHIT-197: loanFacts/homeLoan/repayment now come from useGoalScreenData() (mocked);
// the real paydownView selector still runs over the injected composite data, so these
// fail if the selector reverts. fireRepayment stays on the store (useAppContext mock).
let mockGoal: GoalScreenData;
jest.mock('../queries', () => ({ useGoalScreenData: () => mockGoal }));
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ fireRepayment: jest.fn() }) };
});

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn() }),
  useFocusEffect: () => {},
}));

import Goals from '../../app/(tabs)/goals';

// The payoff-mode math needs a specific facts fixture (higher original + baseRepay than
// the shared LOAN_FACTS default), so this suite overrides makeGoalData's loanFacts default.
const SET_FACTS = { original: 600000, homeValue: 770000, lvr: 0.8, ratePct: 5.74, baseRepay: 3667, extra: 500 };
const goalData = (over: Partial<GoalScreenData> = {}) => makeGoalData({ loanFacts: SET_FACTS, ...over });

beforeEach(() => {
  mockPush.mockClear();
  jest.useFakeTimers({ now: new Date(2026, 6, 4) });
});
afterEach(() => { jest.useRealTimers(); });

it("'ahead': shows the real date + '4y 1m early' + '$83,331' dodged, NOT the old seed", () => {
  mockGoal = goalData({ homeLoan: { balance: 528000, asOf: null } });
  render(<Goals />);
  expect(screen.getByText('Nov 2042')).toBeTruthy();
  expect(screen.getByText('4y 1m early 🏁')).toBeTruthy();
  expect(screen.getByText("Interest you'll dodge")).toBeTruthy();
  expect(screen.getByText('$83,331')).toBeTruthy();
  // Retired seed values must be nowhere on screen.
  expect(screen.queryByText('Aug 2045')).toBeNull();
  expect(screen.queryByText(/4y 3m/)).toBeNull();
  expect(screen.queryByText('$58,200')).toBeNull();
});

it("'partial': one card with the date + 'your extra gets you there', no dodged figure", () => {
  mockGoal = goalData({ homeLoan: { balance: 815000, asOf: null } });
  render(<Goals />);
  expect(screen.getByText('Jun 2074')).toBeTruthy();
  expect(screen.getByText('Your extra repayment is what gets you there 🏁')).toBeTruthy();
  // No "interest dodged" card in this state.
  expect(screen.queryByText("Interest you'll dodge")).toBeNull();
});

it("'flat': the date on 'current repayments', no 'early' claim", () => {
  mockGoal = goalData({ homeLoan: { balance: 528000, asOf: null }, loanFacts: { ...SET_FACTS, extra: 0 } });
  render(<Goals />);
  expect(screen.getByText('Dec 2046')).toBeTruthy();
  expect(screen.getByText('On your current repayments')).toBeTruthy();
  expect(screen.queryByText(/early 🏁/)).toBeNull();
});

it("'none': the honest 'won't pay off' nudge, no fabricated date", () => {
  mockGoal = goalData({ homeLoan: { balance: 900000, asOf: null } }); // payment < interest
  render(<Goals />);
  expect(screen.getByText("Won't pay off at this rate")).toBeTruthy();
  expect(screen.getByText(/Increase your repayment/)).toBeTruthy();
  expect(screen.queryByText('Mortgage-free')).toBeNull();
});

it("'none' with a payoff goal date: shows the required repayment, not the static nudge (WHIT-126)", () => {
  mockGoal = goalData({
    homeLoan: { balance: 900000, asOf: null },
    loanFacts: { ...SET_FACTS, payoffGoalDate: '2035-06-01' },
  });
  render(<Goals />);
  expect(screen.getByText("Won't pay off at this rate")).toBeTruthy();
  // The real required-repayment prompt replaces the static "increase your repayment" copy.
  expect(screen.getByText(/To clear it by Jun 2035 you'd need .* more than now\./)).toBeTruthy();
  expect(screen.queryByText(/Increase your repayment/)).toBeNull();
  // WHIT-215: a realistic goal shows NO "too soon" hint.
  expect(screen.queryByTestId('goal-too-aggressive-hint')).toBeNull();
});

it("'none' with a too-soon goal date UNDER $1M: shows the figure AND the 'too soon' hint (WHIT-215)", () => {
  // 6 months out on a 900k 'none' loan → an honest but absurd (~$150k/mo, >10× current) figure.
  mockGoal = goalData({
    homeLoan: { balance: 900000, asOf: null },
    loanFacts: { ...SET_FACTS, payoffGoalDate: '2027-01-01' },
  });
  render(<Goals />);
  // The honest figure still renders...
  expect(screen.getByText(/To clear it by Jan 2027 you'd need .* more than now\./)).toBeTruthy();
  // ...with the nudge appended beneath it.
  expect(screen.getByTestId('goal-too-aggressive-hint')).toBeTruthy();
  expect(screen.getByText('That target may be too soon — try a later date.')).toBeTruthy();
});

it("'none' with a too-soon goal date OVER $1M: shows the hint in place of the static nudge (WHIT-215)", () => {
  // Next month on a 1.2M loan → required repayment over the $1M cap → figure suppressed.
  mockGoal = goalData({
    homeLoan: { balance: 1_200_000, asOf: null },
    loanFacts: { ...SET_FACTS, payoffGoalDate: '2026-08-01' },
  });
  render(<Goals />);
  expect(screen.getByText("Won't pay off at this rate")).toBeTruthy();
  // The hint replaces BOTH the (suppressed) figure and the generic static copy.
  expect(screen.getByTestId('goal-too-aggressive-hint')).toBeTruthy();
  expect(screen.queryByText(/To clear it by/)).toBeNull();
  expect(screen.queryByText(/Increase your repayment/)).toBeNull();
});

it("'unready' (balance not loaded): renders NO payoff card at all", () => {
  mockGoal = goalData({ homeLoan: { balance: null, asOf: null } });
  render(<Goals />);
  expect(screen.queryByText('Mortgage-free')).toBeNull();
  expect(screen.queryByText("Won't pay off at this rate")).toBeNull();
  expect(screen.queryByText("Interest you'll dodge")).toBeNull();
});
