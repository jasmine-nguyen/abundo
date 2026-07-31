// WHIT-372 — the /mortgage hero states where nothing is genuinely paid down. The hero now gates on
// the shared goalView.paidDownReady flag (like the card), so a balance at/above the original — or a
// sub-dollar paydown that rounds to $0 — falls to a coherent "balance owing" state instead of the
// old incoherent "$1 paid / 0% gone" payoff block. Fail-on-revert: reverting the hero gate back to
// `factsReady && balanceKnown` re-renders the payoff block and reddens these. Same mock scaffold as
// mortgageHero.screen.
import { it, expect, jest, beforeEach, describe } from '@jest/globals';
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { makeGoalData } from './factory';
import type { GoalScreenData } from '../queries';

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

beforeEach(() => { mockGoal = makeGoalData(); });

const OWING_BODY = "You're at the start — your payoff progress will show here as you pay it down.";

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
