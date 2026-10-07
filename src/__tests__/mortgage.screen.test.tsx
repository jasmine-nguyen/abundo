// WHIT-233 — the mortgage screen relocated out of the Goal tab to its own stack route
// (app/mortgage). This locks the RELOCATION-specific behaviour: it renders standalone WITHOUT
// a NavBarsProvider (proving it uses the <Header /> + plain ScrollView detail pattern,
// not the tab's ScrollChromeHeader, which would throw here), and its header reads "Home loan".
// The mortgage CONTENT (payoff cards, repayment, equity, milestone link) is covered by the
// suites repointed to this screen (goals.paydown / repayment.* / milestone / goalErrorStates).
// WHIT-685: drawn over the fake server, so the real screen data code runs.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { EMPTY_LOAN_FACTS } from './factory';
import { PayoffSummary } from '../components/PayoffSummary';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { seedGoal } from './support/goalsScreen';
import { routerSpies, resetRouter } from './support/routerMock';
import { SAVED_MILESTONES } from './support/milestonePlan';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('../context', () => require('./support/contextMock').emptyContextMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import Mortgage from '../../app/mortgage';

const server = installFakeServer();
useTestQueryClient();

beforeEach(() => {
  resetAuth();
  resetRouter();
});

it('renders standalone (no NavBarsProvider) with a "Home loan" header', async () => {
  // If this screen still used ScrollChromeHeader it would throw here (no NavBarsProvider),
  // so a clean render is itself the relocation assertion.
  seedGoal(server);
  await renderWithQueries(<Mortgage />);
  expect(screen.getByText('Home loan')).toBeTruthy();
});

it('shows the live balance owing in the hero when facts are unset', async () => {
  seedGoal(server, {
    loanFacts: EMPTY_LOAN_FACTS,
    homeLoan: { balance: 596642, asOf: null },
  });
  await renderWithQueries(<Mortgage />);
  expect(screen.getByText('YOUR HOME LOAN · BALANCE OWING')).toBeTruthy();
  expect(screen.getByText('$596,642')).toBeTruthy();
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
  expect(screen.getByText('1 of 3 sprints reached')).toBeTruthy();
  expect(screen.getByText('Next: under $200,000')).toBeTruthy();
  // The default plan's rows/targets must NOT drive the mortgage screen once a plan is saved.
  expect(screen.queryByText('3 of 5 sprints reached')).toBeNull();
  expect(screen.queryByText('Next: under $170,000')).toBeNull();
  expect(screen.queryByText('Next: under $544,000')).toBeNull();
});

it('mortgage Sprint summary shows the "set milestones" invite when none is saved', async () => {
  seedGoal(server, { milestones: [], homeLoan: { balance: 596642.43, asOf: '2026-07-04T00:24:37.614Z' } });
  await renderWithQueries(<Mortgage />);
  // No hardcoded default: a user who hasn't set a plan gets an invite, not fake sprints/progress.
  expect(screen.getByText('Set your payoff milestones')).toBeTruthy();
  expect(screen.queryByText('0 of 5 sprints reached')).toBeNull();
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

  // homeLoanError + an over-paid balance: `homeLoanError` is checked BEFORE the balanceKnown owing
  // branch, so the ERROR must win — a balance-read failure is never silently painted as "you're at
  // the start". Reddens if the balanceKnown branch is ever ordered above homeLoanError.
  // WHIT-685: the real screen data only flags homeLoanError when no balance ever loaded, so the
  // over-paid seed never reaches the screen here; the failed read must still show the error.
  it('homeLoanError wins over the over-paid owing state', async () => {
    seedGoal(server, { homeLoan: { balance: 500001, asOf: '2026-07-04T00:00:00Z' } });
    server.fail('/homeloan', 500);
    await renderWithQueries(<Mortgage />);
    expect(screen.getByText("Couldn't load your balance.")).toBeTruthy();
    expect(screen.getByTestId('hero-balance-retry')).toBeTruthy();
    expect(screen.queryByText(OWING_BODY)).toBeNull();
  });

  // THE paidOff===0.5 knife-edge, rendered. Balance 499,999.5 → paidOff 0.5 → Math.round=1 →
  // paidDownReady TRUE → the payoff block renders. fmt(0.5)="$1", and WHIT-391 floors the headline
  // to "1% gone" so it AGREES with the "$1 paid" figure (was the old "$1 / 0% gone"). Reverting the
  // WHIT-391 floor drops it back to "0% gone" and reddens here.
  it('paidOff === 0.5 renders the payoff block reading "$1" next to "1% gone" (floored, coherent)', async () => {
    seedGoal(server, { homeLoan: { balance: 499999.5, asOf: '2026-07-04T00:00:00Z' } });
    await renderWithQueries(<Mortgage />);
    expect(screen.getByText('THE MORTGAGE · PAID DOWN SO FAR')).toBeTruthy();
    expect(screen.getByText('$1')).toBeTruthy();          // fmt(0.5)
    expect(screen.getByText('1% gone')).toBeTruthy();      // WHIT-391: floored to 1, not "0% gone"
    expect(screen.queryByText('0% gone')).toBeNull();      // the old incoherent copy is gone
    expect(screen.getByText('$500,000 to go')).toBeTruthy(); // fmt(499999.5) rounds back up
    expect(screen.queryByText(OWING_BODY)).toBeNull();     // it is NOT routed to the owing state
  });
});

// ===== WHIT-391 (folded from mortgagePayoffFloor.screen.test.tsx) =====
describe('mortgage hero — WHIT-391 sub-0.5% paydown, rendered', () => {
  // [F7] The card's canonical example, rendered: $1,200 paid of a $500k loan (0.24%). The payoff block
  // shows "$1,200" next to "1% gone" (NOT "0% gone"), with the honest "$498,800 to go". Reverting the
  // WHIT-391 floor drops the headline to "0% gone" and reddens the last two assertions.
  it('[F7] $1,200 paid on $500k renders "$1,200" next to "1% gone", never "0% gone"', async () => {
    seedGoal(server, { homeLoan: { balance: 498800, asOf: '2026-07-04T00:00:00Z' } });
    await renderWithQueries(<Mortgage />);
    expect(screen.getByText('THE MORTGAGE · PAID DOWN SO FAR')).toBeTruthy();
    expect(screen.getByText('$1,200')).toBeTruthy();
    expect(screen.getByText('1% gone')).toBeTruthy();
    expect(screen.queryByText('0% gone')).toBeNull();
    expect(screen.getByText('$498,800 to go')).toBeTruthy();
  });

  // [F8] The reconcile's OTHER half: the label is floored to 1, but the progress bar must still fill to
  // the TRUE 0.24% (Bar width={`${paidPct}%`}), NOT snap to 1%. So the bar is visibly near-empty while
  // the words say "1% gone" — deliberate and honest. Assert the serialized tree carries a "0.24%" width
  // next to "1% gone". Reverting the floor leaves the bar at 0.24% but the headline back at 0% (a regress
  // of the reconcile); clamping the BAR to the label (a wrong "fix") would drop the 0.24% width and redden.
  it('[F8] the progress bar fills to the true 0.24%, not the floored 1% (label and bar diverge honestly)', async () => {
    seedGoal(server, { homeLoan: { balance: 498800, asOf: '2026-07-04T00:00:00Z' } });
    await renderWithQueries(<Mortgage />);
    expect(screen.getByText('1% gone')).toBeTruthy();
    const tree = JSON.stringify(screen.toJSON());
    expect(tree).toContain('0.24%');        // Bar fill width uses the raw paidPct
    expect(tree).not.toContain('width":"1%'); // ...and is NOT snapped to the floored label
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

  // Balance ABOVE the original (a redraw/refinance that grew the loan): paidOff is negative, and
  // `fmt` hides the sign — the old un-gated hero showed "$1 paid / 0% gone / owe more than you
  // started". Now it shows the owing state. This is the core over-paid fix.
  it('balance above the original shows the owing state, never a "$1 / 0% gone" block', async () => {
    seedGoal(server, { homeLoan: { balance: 500001, asOf: '2026-07-04T00:00:00Z' } });
    await renderWithQueries(<Mortgage />);
    expect(screen.getByText('YOUR HOME LOAN · BALANCE OWING')).toBeTruthy();
    expect(screen.getByText(OWING_BODY)).toBeTruthy();
    expect(screen.getByText('$500,001')).toBeTruthy();
    expect(screen.queryByText('0% gone')).toBeNull();
    expect(screen.queryByText('$1')).toBeNull();                     // no "$1 paid" from fmt(-1)
    expect(screen.queryByText('THE MORTGAGE · PAID DOWN SO FAR')).toBeNull();
  });

  // Sub-dollar paydown (0 < paidOff < 0.5, rounds to $0): the gap between `paidDownReady`
  // (rounds paidOff) and a naive `paidOff > 0`. Must ALSO route to the owing state — not fall
  // through to the "once your balance loads" waiting copy (the balance IS loaded).
  it('a sub-dollar paydown (rounds to $0) shows the owing state, not the waiting copy', async () => {
    seedGoal(server, { homeLoan: { balance: 499999.6, asOf: '2026-07-04T00:00:00Z' } });
    await renderWithQueries(<Mortgage />);
    expect(screen.getByText('YOUR HOME LOAN · BALANCE OWING')).toBeTruthy();
    expect(screen.getByText(OWING_BODY)).toBeTruthy();
    expect(screen.queryByText('0% gone')).toBeNull();
    expect(screen.queryByText("We'll show your payoff progress once your balance loads.")).toBeNull();
  });
});

// ===== WHIT-372 (folded from payoffSummary.screen.test.tsx) =====
// PURE COMPONENT test — renders <PayoffSummary/> directly (it reads no screen data), so it needs no
// seeded server. WHIT-685 dropped its font-size checks (layout only); the wording checks stay.
describe('PayoffSummary', () => {
  const PROPS = {
    paidOff: 67100,
    paidPctLabel: 13,
    paidPct: 13.42,
    balanceLabel: '$432,900',
    original: 500000,
  } as const;

  it('hero variant: long eyebrow and the shared figures', () => {
    render(<PayoffSummary variant="hero" {...PROPS} />);
    expect(screen.getByText('THE MORTGAGE · PAID DOWN SO FAR')).toBeTruthy();
    expect(screen.getByText('$67,100')).toBeTruthy();
    expect(screen.getByText('13% gone')).toBeTruthy();
    expect(screen.getByText('$432,900 to go')).toBeTruthy();
    expect(screen.getByText('started at $500,000')).toBeTruthy();
  });

  it('card variant: short eyebrow (never the hero one) and the shared figures', () => {
    render(<PayoffSummary variant="card" {...PROPS} />);
    expect(screen.getByText('PAID DOWN SO FAR')).toBeTruthy();
    expect(screen.queryByText('THE MORTGAGE · PAID DOWN SO FAR')).toBeNull();
    expect(screen.getByText('$67,100')).toBeTruthy();
    expect(screen.getByText('13% gone')).toBeTruthy();
    expect(screen.getByText('$432,900 to go')).toBeTruthy();
    expect(screen.getByText('started at $500,000')).toBeTruthy();
  });
});
