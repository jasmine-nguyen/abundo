// WHIT-372 — adversarial gaps on the /mortgage hero branch chain the implementer's owing-state suite
// leaves open. Same mock scaffold as mortgageHero.screen / mortgagePayoffLabel.screen: REAL goalView
// runs over LOAN_FACTS + an injected balance, so every gate is the production selector's.
import { it, expect, jest, beforeEach, describe } from '@jest/globals';
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { makeGoalData, EMPTY_LOAN_FACTS } from './factory';
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
