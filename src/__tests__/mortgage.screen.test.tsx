// WHIT-233 — the mortgage screen relocated out of the Goal tab to its own stack route
// (app/mortgage). This locks the RELOCATION-specific behaviour: it renders standalone WITHOUT
// a NavBarsProvider (proving it uses the <Header showBack /> + plain ScrollView detail pattern,
// not the tab's ScrollChromeHeader, which would throw here), and its header reads "The mortgage".
// The mortgage CONTENT (payoff cards, repayment, equity, milestone link) is covered by the
// suites repointed to this screen (goals.paydown / repayment.* / milestone / goalErrorStates).
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { StyleSheet } from 'react-native';
import { render, screen } from '@testing-library/react-native';
import { makeGoalData, EMPTY_LOAN_FACTS } from './factory';
import { PayoffSummary } from '../components/PayoffSummary';
import type { GoalScreenData } from '../queries';
import type { MilestoneRecord } from '../api';

let mockGoal: GoalScreenData;
jest.mock('../queries', () => ({ useGoalScreenData: () => mockGoal }));
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({}) };
});
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
  useFocusEffect: () => {},
}));

import Mortgage from '../../app/mortgage';

beforeEach(() => {
  mockGoal = makeGoalData();
});

it('renders standalone (no NavBarsProvider) with a "The mortgage" header', () => {
  // If this screen still used ScrollChromeHeader it would throw here (no NavBarsProvider),
  // so a clean render is itself the relocation assertion.
  render(<Mortgage />);
  expect(screen.getByText('The mortgage')).toBeTruthy();
});

it('shows the live balance owing in the hero when facts are unset', () => {
  mockGoal = makeGoalData({
    loanFacts: { original: null, homeValue: null, lvr: null, ratePct: null, baseRepay: null, extra: null },
    homeLoan: { balance: 596642, asOf: null },
  });
  render(<Mortgage />);
  expect(screen.getByText('YOUR HOME LOAN · BALANCE OWING')).toBeTruthy();
  expect(screen.getByText('$596,642')).toBeTruthy();
});

// ===== WHIT-367 (folded from milestoneReadpathMortgage.gaps.screen.test.tsx) =====
// mortgage.tsx also feeds the saved plan into milestoneView (app/mortgage.tsx:27), but the
// implementer only screen-tested milestone.tsx. This locks the mortgage screen's Sprint summary to
// the SEEDED saved list: reverting mortgage.tsx to `milestoneView({ loanFacts, homeLoan })`
// (dropping `milestones`) falls back to the default 5-sprint plan and turns these red. Same mock
// pattern (identical useGoalScreenData / useAppContext / expo-router mocks, same makeGoalData).
const SAVED_PLAN: MilestoneRecord[] = [
  { id: 'a', label: 'Start',  targetBalance: 300000, targetDate: '2026-01-01' },
  { id: 'b', label: 'Midway', targetBalance: 200000, targetDate: '2027-01-01' },
  { id: 'c', label: 'Payoff', targetBalance: 100000, targetDate: '2028-01-01' },
];

it('mortgage Sprint summary reflects the saved plan (count + next target), not the default', () => {
  // 250k clears only 'Start' (300k) of the 3 saved rows → "1 of 3", next 'Midway' (200k).
  // The default 5-sprint plan at this balance would read "3 of 5" / "under $170,000".
  mockGoal = makeGoalData({ milestones: SAVED_PLAN, homeLoan: { balance: 250000, asOf: '2026-07-04T00:24:37.614Z' } });
  render(<Mortgage />);
  expect(screen.getByText('1 of 3 sprints reached')).toBeTruthy();
  expect(screen.getByText('Next: under $200,000')).toBeTruthy();
  // The default plan's rows/targets must NOT drive the mortgage screen once a plan is saved.
  expect(screen.queryByText('3 of 5 sprints reached')).toBeNull();
  expect(screen.queryByText('Next: under $170,000')).toBeNull();
  expect(screen.queryByText('Next: under $544,000')).toBeNull();
});

it('mortgage Sprint summary falls back to the default 5-sprint plan when none is saved', () => {
  mockGoal = makeGoalData({ milestones: [], homeLoan: { balance: 596642.43, asOf: '2026-07-04T00:24:37.614Z' } });
  render(<Mortgage />);
  // A user who hasn't edited sees the unchanged default (0 of 5, Sprint 0 Kickoff at 544k).
  expect(screen.getByText('0 of 5 sprints reached')).toBeTruthy();
  expect(screen.getByText('Next: under $544,000')).toBeTruthy();
});

// Shared by the WHIT-372 owing-state describes folded below (byte-identical const in both siblings).
const OWING_BODY = "You're at the start — your payoff progress will show here as you pay it down.";

// ===== WHIT-233 (folded from mortgageHero.screen.test.tsx) =====
// The mortgage screen's PRIMARY hero: the facts-ready "PAID DOWN SO FAR" state (real payoff progress).
// Same mock scaffold as above; the REAL goalView runs over LOAN_FACTS + an injected live balance.

// [A28] facts set + a live balance below the original → the paid-down-so-far hero:
// LOAN_FACTS.original 500,000 − balance 432,900 = 67,100 paid (13% gone).
it('renders the paid-down-so-far hero with the real paid-off figure and progress', () => {
  mockGoal = makeGoalData({ homeLoan: { balance: 432900, asOf: '2026-07-04T00:00:00Z' } });
  render(<Mortgage />);
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
it('a nearly-paid balance shows "99% gone", never "100% gone" while a balance is owing', () => {
  mockGoal = makeGoalData({ homeLoan: { balance: 1000, asOf: '2026-07-04T00:00:00Z' } });
  render(<Mortgage />);
  expect(screen.getByText('99% gone')).toBeTruthy();       // round(99.8)=100 -> clamped to 99
  expect(screen.queryByText('100% gone')).toBeNull();      // never 100 while $1,000 is owing
  expect(screen.getByText('$1,000 to go')).toBeTruthy();
});

it('a truly $0 balance shows "100% gone" — the label matches the "$0 to go" figure', () => {
  mockGoal = makeGoalData({ homeLoan: { balance: 0, asOf: '2026-07-04T00:00:00Z' } });
  render(<Mortgage />);
  expect(screen.getByText('100% gone')).toBeTruthy();
  expect(screen.getByText('$0 to go')).toBeTruthy();
});

// ===== WHIT-372 (folded from mortgageOwingEdges.screen.test.tsx) =====
describe('mortgage hero — WHIT-372 branch-order edges', () => {
  // Facts UNSET but balance at the original. `!factsReady` is checked BEFORE the new balanceKnown
  // owing branch, so this must stay the SET-UP prompt (route to /loan), never the "you're at the
  // start" owing copy — the un-set-up user must still be told to set up.
  it('facts unset + balance at original → the SET-UP prompt, not the owing copy', () => {
    mockGoal = makeGoalData({ loanFacts: EMPTY_LOAN_FACTS, homeLoan: { balance: 500000, asOf: '2026-07-04T00:00:00Z' } });
    render(<Mortgage />);
    expect(screen.getByText('Set up loan details →')).toBeTruthy();
    expect(screen.queryByText(OWING_BODY)).toBeNull();
    expect(screen.queryByText('THE MORTGAGE · PAID DOWN SO FAR')).toBeNull();
  });

  // homeLoanError + an over-paid balance: `homeLoanError` is checked BEFORE the balanceKnown owing
  // branch, so the ERROR must win — a balance-read failure is never silently painted as "you're at
  // the start". Reddens if the balanceKnown branch is ever ordered above homeLoanError.
  it('homeLoanError wins over the over-paid owing state', () => {
    mockGoal = makeGoalData({ homeLoanError: true, homeLoan: { balance: 500001, asOf: '2026-07-04T00:00:00Z' } });
    render(<Mortgage />);
    expect(screen.getByText("Couldn't load your balance.")).toBeTruthy();
    expect(screen.getByTestId('hero-balance-retry')).toBeTruthy();
    expect(screen.queryByText(OWING_BODY)).toBeNull();
  });

  // THE paidOff===0.5 knife-edge, rendered. Balance 499,999.5 → paidOff 0.5 → Math.round=1 →
  // paidDownReady TRUE → the payoff block renders. fmt(0.5)="$1", and WHIT-391 floors the headline
  // to "1% gone" so it AGREES with the "$1 paid" figure (was the old "$1 / 0% gone"). Reverting the
  // WHIT-391 floor drops it back to "0% gone" and reddens here.
  it('paidOff === 0.5 renders the payoff block reading "$1" next to "1% gone" (floored, coherent)', () => {
    mockGoal = makeGoalData({ homeLoan: { balance: 499999.5, asOf: '2026-07-04T00:00:00Z' } });
    render(<Mortgage />);
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
  it('[F7] $1,200 paid on $500k renders "$1,200" next to "1% gone", never "0% gone"', () => {
    mockGoal = makeGoalData({ homeLoan: { balance: 498800, asOf: '2026-07-04T00:00:00Z' } });
    render(<Mortgage />);
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
  it('[F8] the progress bar fills to the true 0.24%, not the floored 1% (label and bar diverge honestly)', () => {
    mockGoal = makeGoalData({ homeLoan: { balance: 498800, asOf: '2026-07-04T00:00:00Z' } });
    render(<Mortgage />);
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
  it('[E5] balance at the original shows the "balance owing" state, no payoff block', () => {
    mockGoal = makeGoalData({ homeLoan: { balance: 500000, asOf: '2026-07-04T00:00:00Z' } });
    render(<Mortgage />);
    expect(screen.getByText('YOUR HOME LOAN · BALANCE OWING')).toBeTruthy();
    expect(screen.getByText(OWING_BODY)).toBeTruthy();
    expect(screen.getByText('$500,000')).toBeTruthy();               // the real balance, big
    expect(screen.queryByText('0% gone')).toBeNull();
    expect(screen.queryByText('THE MORTGAGE · PAID DOWN SO FAR')).toBeNull();
  });

  // Balance ABOVE the original (a redraw/refinance that grew the loan): paidOff is negative, and
  // `fmt` hides the sign — the old un-gated hero showed "$1 paid / 0% gone / owe more than you
  // started". Now it shows the owing state. This is the core over-paid fix.
  it('balance above the original shows the owing state, never a "$1 / 0% gone" block', () => {
    mockGoal = makeGoalData({ homeLoan: { balance: 500001, asOf: '2026-07-04T00:00:00Z' } });
    render(<Mortgage />);
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
  it('a sub-dollar paydown (rounds to $0) shows the owing state, not the waiting copy', () => {
    mockGoal = makeGoalData({ homeLoan: { balance: 499999.6, asOf: '2026-07-04T00:00:00Z' } });
    render(<Mortgage />);
    expect(screen.getByText('YOUR HOME LOAN · BALANCE OWING')).toBeTruthy();
    expect(screen.getByText(OWING_BODY)).toBeTruthy();
    expect(screen.queryByText('0% gone')).toBeNull();
    expect(screen.queryByText("We'll show your payoff progress once your balance loads.")).toBeNull();
  });
});

// ===== WHIT-372 (folded from payoffSummary.screen.test.tsx) =====
// PURE COMPONENT test — renders <PayoffSummary/> directly; the module-level jest.mock('../queries'/
// '../context'/'expo-router') above are INERT for these two (PayoffSummary uses no context/query hooks).
// PROPS/styleOf kept block-scoped inside the describe.
describe('PayoffSummary', () => {
  const PROPS = {
    paidOff: 67100,
    paidPctLabel: 13,
    paidPct: 13.42,
    balanceLabel: '$432,900',
    original: 500000,
  } as const;

  const styleOf = (text: string) => StyleSheet.flatten(screen.getByText(text).props.style);

  it('hero variant: long eyebrow, shared figures, and the hero size tuning verbatim', () => {
    render(<PayoffSummary variant="hero" {...PROPS} />);
    expect(screen.getByText('THE MORTGAGE · PAID DOWN SO FAR')).toBeTruthy();
    expect(screen.getByText('$67,100')).toBeTruthy();
    expect(screen.getByText('13% gone')).toBeTruthy();
    expect(screen.getByText('$432,900 to go')).toBeTruthy();
    expect(screen.getByText('started at $500,000')).toBeTruthy();
    // The exact per-variant figure + eyebrow tuning, so an extraction typo (not just a swapped
    // font size) reddens: hero figure 48/lineHeight 48/letterSpacing −2; eyebrow 12.5, no marginTop.
    const figure = styleOf('$67,100');
    expect(figure.fontSize).toBe(48);
    expect(figure.lineHeight).toBe(48);
    expect(figure.letterSpacing).toBe(-2);
    const eyebrow = styleOf('THE MORTGAGE · PAID DOWN SO FAR');
    expect(eyebrow.fontSize).toBe(12.5);
    expect(eyebrow.marginTop).toBeUndefined();
  });

  it('card variant: short eyebrow (never the hero one), shared figures, and the card size tuning verbatim', () => {
    render(<PayoffSummary variant="card" {...PROPS} />);
    expect(screen.getByText('PAID DOWN SO FAR')).toBeTruthy();
    expect(screen.queryByText('THE MORTGAGE · PAID DOWN SO FAR')).toBeNull();
    expect(screen.getByText('$67,100')).toBeTruthy();
    expect(screen.getByText('13% gone')).toBeTruthy();
    expect(screen.getByText('$432,900 to go')).toBeTruthy();
    expect(screen.getByText('started at $500,000')).toBeTruthy();
    // Card figure 30/letterSpacing −1/flexShrink 1 (no lineHeight); eyebrow 12 with marginTop 15.
    const figure = styleOf('$67,100');
    expect(figure.fontSize).toBe(30);
    expect(figure.letterSpacing).toBe(-1);
    expect(figure.flexShrink).toBe(1);
    const eyebrow = styleOf('PAID DOWN SO FAR');
    expect(eyebrow.fontSize).toBe(12);
    expect(eyebrow.marginTop).toBe(15);
  });
});
