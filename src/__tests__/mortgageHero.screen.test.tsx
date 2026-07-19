// WHIT-233 — the mortgage screen's PRIMARY hero: the facts-ready "WHITTLED SO FAR" state
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
  return { ...actual, useAppContext: () => ({ fireRepayment: jest.fn() }) };
});
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
  useFocusEffect: () => {},
}));

import Mortgage from '../../app/mortgage';

beforeEach(() => { mockGoal = makeGoalData(); });

// [A28] facts set + a live balance below the original → the whittled-so-far hero:
// LOAN_FACTS.original 500,000 − balance 432,900 = 67,100 paid (13% gone).
it('renders the whittled-so-far hero with the real paid-off figure and progress', () => {
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
