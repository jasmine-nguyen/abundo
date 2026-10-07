// WHIT-114 — GAP screen tests for the mortgage-screen payoff mini-cards. There is no
// existing screen test for paydownView's rendering; this locks that each `mode`
// draws the RIGHT card (and that the retired seed values are gone).
//
// The clock is pinned to 2026-07-04 because goals.tsx calls paydownView(s) with
// no injected `today` (it uses new Date()); pinning makes the projected month-year
// deterministic instead of drifting with the wall clock.
// WHIT-685: loanFacts/homeLoan/repayment come from the fake server through the real screen data
// code, and the real paydownView selector runs over them, so these fail if either reverts.
// useAppContext is stubbed empty (the screen doesn't read it).
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { screen } from '@testing-library/react-native';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { pinToday } from './support/clock';
import { seedGoal } from './support/goalsScreen';
import { resetRouter } from './support/routerMock';
import type { LoanFacts } from '../api';
import type { HomeLoanState } from '../model';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('../context', () => require('./support/contextMock').realContextWith(() => ({})));

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import Mortgage from '../../app/mortgage';

const server = installFakeServer();
useTestQueryClient();

// The payoff-mode math needs a specific facts fixture (higher original + baseRepay than
// the shared LOAN_FACTS default), so this suite overrides the kit's loanFacts default.
const SET_FACTS: LoanFacts = { original: 600000, homeValue: 770000, lvr: 0.8, ratePct: 5.74, baseRepay: 3667, extra: 500, payoffGoalDate: null };
const seedPaydown = (over: { homeLoan: HomeLoanState; loanFacts?: LoanFacts }) => seedGoal(server, { loanFacts: SET_FACTS, ...over });

beforeEach(() => {
  resetAuth();
  resetRouter();
  pinToday(new Date(2026, 6, 4));
});
afterEach(() => { jest.useRealTimers(); });

it("'ahead': shows the real date + '4y 1m early' + '$83,331' dodged, NOT the old seed", async () => {
  seedPaydown({ homeLoan: { balance: 528000, asOf: null } });
  await renderWithQueries(<Mortgage />);
  expect(screen.getByText('Nov 2042')).toBeTruthy();
  expect(screen.getByText('4y 1m early 🏁')).toBeTruthy();
  expect(screen.getByText("Interest you'll dodge")).toBeTruthy();
  expect(screen.getByText('$83,331')).toBeTruthy();
  // Retired seed values must be nowhere on screen.
  expect(screen.queryByText('Aug 2045')).toBeNull();
  expect(screen.queryByText(/4y 3m/)).toBeNull();
  expect(screen.queryByText('$58,200')).toBeNull();
});

it("'partial': one card with the date + 'your extra gets you there', no dodged figure", async () => {
  seedPaydown({ homeLoan: { balance: 815000, asOf: null } });
  await renderWithQueries(<Mortgage />);
  expect(screen.getByText('Jun 2074')).toBeTruthy();
  expect(screen.getByText('Your extra repayment is what gets you there 🏁')).toBeTruthy();
  // No "interest dodged" card in this state.
  expect(screen.queryByText("Interest you'll dodge")).toBeNull();
});

it("'flat': the date on 'current repayments', no 'early' claim", async () => {
  seedPaydown({ homeLoan: { balance: 528000, asOf: null }, loanFacts: { ...SET_FACTS, extra: 0 } });
  await renderWithQueries(<Mortgage />);
  expect(screen.getByText('Dec 2046')).toBeTruthy();
  expect(screen.getByText('On your current repayments')).toBeTruthy();
  expect(screen.queryByText(/early 🏁/)).toBeNull();
});

it("'none': the honest 'won't pay off' nudge, no fabricated date", async () => {
  seedPaydown({ homeLoan: { balance: 900000, asOf: null } }); // payment < interest
  await renderWithQueries(<Mortgage />);
  expect(screen.getByText("Won't pay off at this rate")).toBeTruthy();
  expect(screen.getByText(/Increase your repayment/)).toBeTruthy();
  expect(screen.queryByText('Mortgage-free')).toBeNull();
});

it("'none' with a payoff goal date: shows the required repayment, not the static nudge (WHIT-126)", async () => {
  seedPaydown({
    homeLoan: { balance: 900000, asOf: null },
    loanFacts: { ...SET_FACTS, payoffGoalDate: '2035-06-01' },
  });
  await renderWithQueries(<Mortgage />);
  expect(screen.getByText("Won't pay off at this rate")).toBeTruthy();
  // The real required-repayment prompt replaces the static "increase your repayment" copy.
  expect(screen.getByText(/To clear it by Jun 2035 you'd need .* more than now\./)).toBeTruthy();
  expect(screen.queryByText(/Increase your repayment/)).toBeNull();
  // WHIT-215: a realistic goal shows NO "too soon" hint.
  expect(screen.queryByTestId('goal-too-aggressive-hint')).toBeNull();
});

it("'none' with a too-soon goal date UNDER $1M: shows the figure AND the 'too soon' hint (WHIT-215)", async () => {
  // 6 months out on a 900k 'none' loan → an honest but absurd (~$150k/mo, >10× current) figure.
  seedPaydown({
    homeLoan: { balance: 900000, asOf: null },
    loanFacts: { ...SET_FACTS, payoffGoalDate: '2027-01-01' },
  });
  await renderWithQueries(<Mortgage />);
  // The honest figure still renders...
  expect(screen.getByText(/To clear it by Jan 2027 you'd need .* more than now\./)).toBeTruthy();
  // ...with the nudge appended beneath it.
  expect(screen.getByTestId('goal-too-aggressive-hint')).toBeTruthy();
  expect(screen.getByText('That target may be too soon — try a later date.')).toBeTruthy();
});

it("'none' with a too-soon goal date OVER $1M: shows the hint in place of the static nudge (WHIT-215)", async () => {
  // Next month on a 1.2M loan → required repayment over the $1M cap → figure suppressed.
  seedPaydown({
    homeLoan: { balance: 1_200_000, asOf: null },
    loanFacts: { ...SET_FACTS, payoffGoalDate: '2026-08-01' },
  });
  await renderWithQueries(<Mortgage />);
  expect(screen.getByText("Won't pay off at this rate")).toBeTruthy();
  // The hint replaces BOTH the (suppressed) figure and the generic static copy.
  expect(screen.getByTestId('goal-too-aggressive-hint')).toBeTruthy();
  expect(screen.queryByText(/To clear it by/)).toBeNull();
  expect(screen.queryByText(/Increase your repayment/)).toBeNull();
});

it("'unready' (balance not loaded): renders NO payoff card at all", async () => {
  seedPaydown({ homeLoan: { balance: null, asOf: null } });
  await renderWithQueries(<Mortgage />);
  expect(screen.queryByText('Mortgage-free')).toBeNull();
  expect(screen.queryByText("Won't pay off at this rate")).toBeNull();
  expect(screen.queryByText("Interest you'll dodge")).toBeNull();
});
