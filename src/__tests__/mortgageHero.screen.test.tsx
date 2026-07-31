// WHIT-233 — the mortgage screen's PRIMARY hero: the facts-ready "PAID DOWN SO FAR" state
// (real payoff progress). The relocation kept this content verbatim, but no repointed suite
// asserts the hero eyebrow / paid-off figure / % — they assert the payoff mini-cards, sprint
// row, or the facts-UNSET hero instead. This locks the headline the whole screen exists for,
// so a relocation that dropped or garbled it would redden here. Same mock scaffold as
// mortgage.screen.test; the REAL goalView runs over the LOAN_FACTS fixture + an injected
// live balance, so the figures are the production selector's, not re-implemented.
import { it, expect, jest, beforeEach } from '@jest/globals';
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
