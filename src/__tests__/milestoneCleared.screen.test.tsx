// GAP screen test for the Home Loan Milestone screen (WHIT-8): the fully-cleared
// state the implementer's milestone.screen.test.tsx doesn't render — every Sprint
// target reached. The "NEXT MILESTONE" callout must disappear (nextMilestone null
// gates it) and the hero must report "5 of 5 milestones reached" rather than a
// stale next-target prompt. WHIT-197: the balance/facts come from the cached query
// layer, so useGoalScreenData() is mocked (the real milestoneView still runs).
import { describe, it, expect, jest } from '@jest/globals';
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { makeGoalData } from './factory';
import type { GoalScreenData } from '../queries';

let mockGoal: GoalScreenData;
jest.mock('../queries', () => ({ useGoalScreenData: () => mockGoal }));

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
  useFocusEffect: () => {},
}));

import Milestone from '../../app/milestone';

it('hides the NEXT MILESTONE callout once every target is cleared', () => {
  // 40000 is below the Sprint 4 target (55000): all five milestones cleared.
  mockGoal = makeGoalData({ homeLoan: { balance: 40000, asOf: '2029-07-01T00:00:00.000Z' } });
  render(<Milestone />);

  expect(screen.getByText('5 of 5 milestones reached')).toBeTruthy();
  // No next target to chase => the callout and its "to go" line are gone.
  expect(screen.queryByText('NEXT MILESTONE')).toBeNull();
  expect(screen.queryByText(/to go$/)).toBeNull();
});
