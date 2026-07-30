// WHIT-378 — adversarial GAP coverage for the equity card across BOTH screens.
// Implementer's milestone.screen.test.tsx locks the exact-50% mortgage case + the
// "no target" degrade. These add:
//   [A8] mortgage chip ROUNDS a non-round pct (49.6% -> "50%") — proves Math.round in
//        app/mortgage.tsx:234 (implementer only ever used an exact 50%).
//   [A9] the MILESTONE screen IGNORES depositTarget entirely: with a target set it shows
//        the plain equity figure and NONE of the mortgage card's target chrome
//        (regression guard for the scope boundary — milestone.tsx must never wire it in).
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { makeGoalData, LOAN_FACTS } from './factory';
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
import Milestone from '../../app/milestone';

beforeEach(() => { mockGoal = makeGoalData(); });

it('[A8] mortgage equity chip ROUNDS the pct: equity 49,600 / target 100,000 -> "50%"', () => {
  // 49600/100000 = 49.6% -> Math.round -> 50. balance 566400 -> equity 49600.
  mockGoal = makeGoalData({ loanFacts: { ...LOAN_FACTS, depositTarget: 100000 }, homeLoan: { balance: 566400, asOf: '2026-07-04T00:24:37.614Z' } });
  render(<Mortgage />);
  expect(screen.getByText('$49,600 unlocked')).toBeTruthy();
  expect(screen.getByText('of $100,000 needed')).toBeTruthy();
  expect(screen.getByText('50%')).toBeTruthy();      // rounded up from 49.6
  expect(screen.queryByText('49.6%')).toBeNull();    // fail-on-revert: dropping Math.round -> "49.6%"
});

it('[A9] the MILESTONE equity card ignores a set depositTarget — no chip, no "needed", no bar', () => {
  // Same fixture that drives the mortgage card into its target-set state; the milestone
  // screen reads a different selector (usableEquityLabel) and must stay target-agnostic.
  mockGoal = makeGoalData({ loanFacts: { ...LOAN_FACTS, depositTarget: 100000 }, homeLoan: { balance: 566000, asOf: '2026-07-04T00:24:37.614Z' } });
  render(<Milestone />);
  // The plain equity figure still shows (equity 50000)...
  expect(screen.getByText('$50,000')).toBeTruthy();
  expect(screen.getByText('Equity for your next place')).toBeTruthy();
  expect(screen.getByText(/your LVR × your home's value/)).toBeTruthy();  // milestone's own body
  // ...but NONE of the mortgage card's deposit-target chrome leaks in.
  expect(screen.queryByText(/of .* needed/)).toBeNull();
  expect(screen.queryByText('Set deposit target →')).toBeNull();
  expect(screen.queryByText('50%')).toBeNull();   // no target-derived percentage
  expect(screen.queryByText('$100,000')).toBeNull();  // the target denominator never appears
});
