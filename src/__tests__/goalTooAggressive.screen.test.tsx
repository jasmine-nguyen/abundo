// WHIT-215 — GAP screen test: the "too soon" hint is DERIVED from the selector each render,
// not sticky. The implementer's goals.paydown.screen.test.tsx locks the three static
// renders (hint under the figure / hint replacing static / no hint when realistic). This
// adds the dynamic case they didn't: editing the goal date to a realistic one must CLEAR
// the hint on the next render. Same mock pattern; fake clock pinned to 2026-07-04.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
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

const SET_FACTS = { original: 600000, homeValue: 770000, lvr: 0.8, ratePct: 5.74, baseRepay: 3667, extra: 500 };
const goalData = (over: Partial<GoalScreenData> = {}) => makeGoalData({ loanFacts: SET_FACTS, ...over });

beforeEach(() => { jest.useFakeTimers({ now: new Date(2026, 6, 4) }); });
afterEach(() => { jest.useRealTimers(); });

it('editing the goal date from too-soon to realistic CLEARS the hint on re-render (WHIT-215, NEW)', () => {
  // Start too-soon: 6 months out on a 900k 'none' loan → hint shown.
  mockGoal = goalData({
    homeLoan: { balance: 900000, asOf: null },
    loanFacts: { ...SET_FACTS, payoffGoalDate: '2027-01-01' },
  });
  const { rerender } = render(<Mortgage />);
  expect(screen.getByTestId('goal-too-aggressive-hint')).toBeTruthy();

  // User pushes the goal date out to a realistic one; the very next render must drop the hint.
  mockGoal = goalData({
    homeLoan: { balance: 900000, asOf: null },
    loanFacts: { ...SET_FACTS, payoffGoalDate: '2035-06-01' },
  });
  rerender(<Mortgage />);
  expect(screen.queryByTestId('goal-too-aggressive-hint')).toBeNull();
  // The honest figure still renders — the loan is still 'none', just no longer too soon.
  expect(screen.getByText(/To clear it by Jun 2035 you'd need .* more than now\./)).toBeTruthy();
});
