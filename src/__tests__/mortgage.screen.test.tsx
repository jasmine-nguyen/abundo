// WHIT-233 — the mortgage screen relocated out of the Goal tab to its own stack route
// (app/mortgage). This locks the RELOCATION-specific behaviour: it renders standalone WITHOUT
// a NavBarsProvider (proving it uses the <Header showBack /> + plain ScrollView detail pattern,
// not the tab's ScrollChromeHeader, which would throw here), and its header reads "The mortgage".
// The mortgage CONTENT (payoff cards, repayment, equity, milestone link) is covered by the
// suites repointed to this screen (goals.paydown / repayment.* / milestone / goalErrorStates).
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { makeGoalData } from './factory';
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
