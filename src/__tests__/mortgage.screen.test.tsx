// WHIT-233 — the mortgage screen (app/mortgage): the hero's "% gone" payoff block and its gate,
// the balance states, and pull to refresh. The payoff cards, repayment, equity and milestone link
// are covered by goals.paydown / repayment.* / milestone.
// WHIT-685: drawn over the fake server, so the real screen data code runs.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { act, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { EMPTY_LOAN_FACTS } from './factory';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { seedGoal } from './support/goalsScreen';
import { routerSpies, resetRouter } from './support/routerMock';
import { SAVED_MILESTONES } from './support/milestonePlan';
import { pullControl } from './support/pull';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('../context', () => require('./support/contextMock').realContextWith(() => ({})));
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import Mortgage from '../../app/mortgage';

const server = installFakeServer();
useTestQueryClient();

beforeEach(() => {
  resetAuth();
  resetRouter();
});

// ===== WHIT-367 (folded from milestoneReadpathMortgage.gaps.screen.test.tsx) =====
// mortgage.tsx also feeds the saved plan into milestoneView (app/mortgage.tsx:27), but the
// implementer only screen-tested milestone.tsx. This locks the mortgage screen's Sprint summary to
// the SEEDED saved list: reverting mortgage.tsx to `milestoneView({ loanFacts, homeLoan })`
// (dropping `milestones`) falls back to the default 5-sprint plan and turns these red.
it('mortgage Sprint summary reflects the saved plan (count + next target), not the default', async () => {
  // 250k clears only 'Start' (300k) of the 3 saved rows → "1 of 3", next 'Midway' (200k).
  // The default 5-sprint plan at this balance would read "3 of 5" / "under $170,000".
  seedGoal(server, { milestones: SAVED_MILESTONES, homeLoan: { balance: 250000, asOf: '2026-07-04T00:24:37.614Z' } });
  await renderWithQueries(<Mortgage />);
  expect(screen.getByText('1 of 3 milestones reached')).toBeTruthy();
  expect(screen.getByText('Next: under $200,000 → unlocks $416,000 equity')).toBeTruthy();
  // The default plan's rows/targets must NOT drive the mortgage screen once a plan is saved.
  expect(screen.queryByText('3 of 5 milestones reached')).toBeNull();
  expect(screen.queryByText('Next: under $170,000')).toBeNull();
  expect(screen.queryByText('Next: under $544,000')).toBeNull();
});

it('the no-plan invite taps straight into the editor (not the read-only detail)', async () => {
  seedGoal(server, { milestones: [], homeLoan: { balance: 596642.43, asOf: null } });
  await renderWithQueries(<Mortgage />);
  fireEvent.press(screen.getByTestId('milestone-link'));
  expect(routerSpies.push).toHaveBeenCalledWith('/milestone/edit');
});

// Shared by the WHIT-372 owing-state describes folded below (byte-identical const in both siblings).
const OWING_BODY = "You're at the start — your payoff progress will show here as you pay it down.";

// ===== WHIT-233 (folded from mortgageHero.screen.test.tsx) =====
// The mortgage screen's PRIMARY hero: the facts-ready "PAID DOWN SO FAR" state (real payoff progress).
// The REAL goalView runs over LOAN_FACTS + the seeded live balance.

// [A28] facts set + a live balance below the original → the paid-down-so-far hero:
// LOAN_FACTS.original 500,000 − balance 432,900 = 67,100 paid (13% gone).
it('renders the paid-down-so-far hero with the real paid-off figure and progress', async () => {
  seedGoal(server, { homeLoan: { balance: 432900, asOf: '2026-07-04T00:00:00Z' } });
  await renderWithQueries(<Mortgage />);
  expect(screen.getByText('THE MORTGAGE · PAID DOWN SO FAR')).toBeTruthy();
  expect(screen.getByText('$67,100')).toBeTruthy();          // paidOff = 500000 - 432900
  expect(screen.getByText('13% gone')).toBeTruthy();          // round(67100/500000*100)
  expect(screen.getByText('$432,900 to go')).toBeTruthy();    // balanceLabel
  expect(screen.getByText('started at $500,000')).toBeTruthy();
  // The set-up prompt must NOT show — this is the real-progress state, not the unset one.
  expect(screen.queryByText('Set up loan details →')).toBeNull();
});

// WHIT-372 — the coherence fix + fail-on-revert for the drift the card names. The hero used a
// bare Math.round(paidPct), so a nearly-paid loan showed the incoherent "100% gone" next to
// "$1,000 to go". Reading the shared clamped goalView.paidPctLabel, a still-owing balance now
// reads "99% gone". Reverting app/mortgage.tsx to Math.round(g.paidPct) reddens this.
it('a nearly-paid balance shows "99% gone", never "100% gone" while a balance is owing', async () => {
  seedGoal(server, { homeLoan: { balance: 1000, asOf: '2026-07-04T00:00:00Z' } });
  await renderWithQueries(<Mortgage />);
  expect(screen.getByText('99% gone')).toBeTruthy();       // round(99.8)=100 -> clamped to 99
  expect(screen.queryByText('100% gone')).toBeNull();      // never 100 while $1,000 is owing
  expect(screen.getByText('$1,000 to go')).toBeTruthy();
});

it('a truly $0 balance shows "100% gone" — the label matches the "$0 to go" figure', async () => {
  seedGoal(server, { homeLoan: { balance: 0, asOf: '2026-07-04T00:00:00Z' } });
  await renderWithQueries(<Mortgage />);
  expect(screen.getByText('100% gone')).toBeTruthy();
  expect(screen.getByText('$0 to go')).toBeTruthy();
});

// ===== WHIT-372 (folded from mortgageOwingEdges.screen.test.tsx) =====
// WHIT-121 #4: each failed read's Retry is a labelled button and its error copy a polite live region.
it.each([
  ['/homeloan', 'hero-balance-retry', 'Retry loading your balance', "Couldn't load your balance."],
  ['/repayment', 'repayment-retry', 'Retry loading your last repayment', "Couldn't load your last repayment."],
])('a failed %s read shows a screen-reader-labelled Retry', async (route, testID, label, copy) => {
  seedGoal(server);
  server.fail(route, 500);
  await renderWithQueries(<Mortgage />);
  const retry = screen.getByTestId(testID);
  expect(retry.props.accessibilityRole).toBe('button');
  expect(retry.props.accessibilityLabel).toBe(label);
  expect(screen.getByText(copy).props.accessibilityLiveRegion).toBe('polite');
});

describe('mortgage hero — WHIT-372 branch-order edges', () => {
  // Facts UNSET but balance at the original. `!factsReady` is checked BEFORE the new balanceKnown
  // owing branch, so this must stay the SET-UP prompt (route to /loan), never the "you're at the
  // start" owing copy — the un-set-up user must still be told to set up.
  it('facts unset + balance at original → the SET-UP prompt, not the owing copy', async () => {
    seedGoal(server, { loanFacts: EMPTY_LOAN_FACTS, homeLoan: { balance: 500000, asOf: '2026-07-04T00:00:00Z' } });
    await renderWithQueries(<Mortgage />);
    expect(screen.getByText('Set up loan details →')).toBeTruthy();
    expect(screen.queryByText(OWING_BODY)).toBeNull();
    expect(screen.queryByText('THE MORTGAGE · PAID DOWN SO FAR')).toBeNull();
  });
});

// ===== WHIT-372 (folded from mortgagePayoffLabel.screen.test.tsx) =====
describe('mortgage hero — WHIT-372 "balance owing" states (nothing genuinely paid down)', () => {
  // [E5] Balance EXACTLY at the original (fresh loan / redraw back to full): paidOff is 0, so it's
  // not paidDownReady → the honest "balance owing" state, NOT a "$500,000 paid / 0% gone" block.
  it('[E5] balance at the original shows the "balance owing" state, no payoff block', async () => {
    seedGoal(server, { homeLoan: { balance: 500000, asOf: '2026-07-04T00:00:00Z' } });
    await renderWithQueries(<Mortgage />);
    expect(screen.getByText('YOUR HOME LOAN · BALANCE OWING')).toBeTruthy();
    expect(screen.getByText(OWING_BODY)).toBeTruthy();
    expect(screen.getByText('$500,000')).toBeTruthy();               // the real balance, big
    expect(screen.queryByText('0% gone')).toBeNull();
    expect(screen.queryByText('THE MORTGAGE · PAID DOWN SO FAR')).toBeNull();
  });
});

// WHIT-822 — pull-to-refresh.
it('user can pull down on Home loan to reload the balance', async () => {
  seedGoal(server, { milestones: SAVED_MILESTONES, homeLoan: { balance: 432900, asOf: '2026-07-04T00:00:00Z' } });
  await renderWithQueries(<Mortgage />);
  expect(screen.getByText('$432,900 to go')).toBeTruthy();

  seedGoal(server, { milestones: SAVED_MILESTONES, homeLoan: { balance: 430000, asOf: '2026-07-05T00:00:00Z' } });
  const held = server.hold('/homeloan');
  act(() => { pullControl().props.onRefresh(); });
  await waitFor(() => expect(pullControl().props.refreshing).toBe(true));

  held.release();
  await waitFor(() => expect(pullControl().props.refreshing).toBe(false));
  expect(await screen.findByText('$430,000 to go')).toBeTruthy();
});