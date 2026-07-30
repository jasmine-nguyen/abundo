// Screen test for the milestone read path (WHIT-367): the Home Loan Milestone screen
// renders the user's SAVED plan when one exists, and the built-in default when it
// doesn't. Mirrors milestone.screen.test.tsx — useGoalScreenData is mocked (the real
// milestoneView selector still runs over the mocked composite), so seeding `milestones`
// on the composite drives what the screen shows.
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

import Milestone from '../../app/milestone';

const SAVED_PLAN: MilestoneRecord[] = [
  { id: 'a', label: 'Start',  targetBalance: 300000, targetDate: '2026-01-01' },
  { id: 'b', label: 'Midway', targetBalance: 200000, targetDate: '2027-01-01' },
  { id: 'c', label: 'Payoff', targetBalance: 100000, targetDate: '2028-01-01' },
];

beforeEach(() => {
  mockGoal = makeGoalData();
});

it('renders the saved milestone plan when one exists', () => {
  mockGoal = makeGoalData({ milestones: SAVED_PLAN, homeLoan: { balance: 250000, asOf: null } });
  render(<Milestone />);
  // The user's own rows — label + step number derived from position.
  expect(screen.getByText('Sprint 0 · Start')).toBeTruthy();
  expect(screen.getByText('Sprint 1 · Midway')).toBeTruthy();
  expect(screen.getByText('under $300,000 · Jan 2026')).toBeTruthy();
  // The built-in default plan's rows must NOT appear once a saved plan is present.
  expect(screen.queryByText('Sprint 0 · Kickoff')).toBeNull();
  expect(screen.queryByText('under $544,000 · Jun 2026')).toBeNull();
});

it('falls back to the built-in default plan when no milestones are saved', () => {
  mockGoal = makeGoalData({ milestones: [], homeLoan: { balance: 596642.43, asOf: null } });
  render(<Milestone />);
  // The default 5-sprint plan still renders — a user who hasn't edited sees no change.
  expect(screen.getByText('Sprint 0 · Kickoff')).toBeTruthy();
  expect(screen.getByText('Sprint 4 · Target')).toBeTruthy();
});
