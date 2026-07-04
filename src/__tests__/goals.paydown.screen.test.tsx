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
import type { AppContext } from '../context';

let mockState: AppContext;
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn() }),
}));

import Goals from '../../app/(tabs)/goals';

const GOAL = {
  original: 500000, balance: 432900, homeValue: 640000, startYear: 'Mar 2021',
  ratePct: 5.74, baseRepay: 1240, extra: 200,
  lastRepay: { amount: 1440, principal: 1208, interest: 232, date: 'Today · 9:02am' },
};
const SET_FACTS = { original: 600000, homeValue: 770000, lvr: 0.8, ratePct: 5.74, baseRepay: 3667, extra: 500 };
const NO_REPAYMENT = { amount: null, date: null, principal: null, interest: null };

function state(over: Partial<AppContext>): AppContext {
  return {
    homeLoan: { balance: null, asOf: null },
    loanFacts: SET_FACTS,
    repayment: NO_REPAYMENT,
    goal: GOAL,
    cycleLen: 14,                      // fortnightly by default
    category: (_id: string | null) => undefined,
    fireRepayment: jest.fn(),
    ...over,
  } as unknown as AppContext;
}

beforeEach(() => {
  mockPush.mockClear();
  jest.useFakeTimers({ now: new Date(2026, 6, 4) });
});
afterEach(() => { jest.useRealTimers(); });

it("'ahead': shows the real date + '4y 1m early' + '$83,331' dodged, NOT the old seed", () => {
  mockState = state({ homeLoan: { balance: 528000, asOf: null } });
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
  mockState = state({ homeLoan: { balance: 815000, asOf: null } });
  render(<Goals />);
  expect(screen.getByText('Jun 2074')).toBeTruthy();
  expect(screen.getByText('Your extra repayment is what gets you there 🏁')).toBeTruthy();
  // No "interest dodged" card in this state.
  expect(screen.queryByText("Interest you'll dodge")).toBeNull();
});

it("'flat': the date on 'current repayments', no 'early' claim", () => {
  mockState = state({ homeLoan: { balance: 528000, asOf: null }, loanFacts: { ...SET_FACTS, extra: 0 } });
  render(<Goals />);
  expect(screen.getByText('Dec 2046')).toBeTruthy();
  expect(screen.getByText('On your current repayments')).toBeTruthy();
  expect(screen.queryByText(/early 🏁/)).toBeNull();
});

it("'none': the honest 'won't pay off' nudge, no fabricated date", () => {
  mockState = state({ homeLoan: { balance: 900000, asOf: null } }); // payment < interest
  render(<Goals />);
  expect(screen.getByText("Won't pay off at this rate")).toBeTruthy();
  expect(screen.getByText(/Increase your repayment/)).toBeTruthy();
  expect(screen.queryByText('Mortgage-free')).toBeNull();
});

it("'unready' (balance not loaded): renders NO payoff card at all", () => {
  mockState = state({ homeLoan: { balance: null, asOf: null } });
  render(<Goals />);
  expect(screen.queryByText('Mortgage-free')).toBeNull();
  expect(screen.queryByText("Won't pay off at this rate")).toBeNull();
  expect(screen.queryByText("Interest you'll dodge")).toBeNull();
});
