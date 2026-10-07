// WHIT-749 slice 2 — the goal page's edges: header-only when the goal is unknown or the pay cycle
// never loaded (never a wrong-cycle pace), no MILESTONES section without checkpoints, and the
// past-date nudge going to Edit. Through the fake server and the REAL balanceGoalView.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { screen, fireEvent } from '@testing-library/react-native';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { pinToday } from './support/clock';
import { seedHubWith } from './support/goalsScreen';
import { GOAL_TODAY, growGoal } from './support/goalPace';
import { routerSpies, setParams, resetRouter } from './support/routerMock';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import GoalDetail from '../../app/goal/[id]';

const server = installFakeServer();
useTestQueryClient();

const GOAL = growGoal('g1', { name: 'Holiday' });

beforeEach(() => {
  resetRouter();
  resetAuth();
  pinToday(GOAL_TODAY);
});
afterEach(() => { jest.useRealTimers(); });

describe('goal page edges', () => {
  it('an unknown goal id shows only the header — no Edit, no progress', async () => {
    seedHubWith(server, { goals: [GOAL] });
    setParams({ id: 'nope' });
    await renderWithQueries(<GoalDetail />);
    expect(screen.getByText('Goal')).toBeTruthy();
    expect(screen.queryByTestId('goal-detail-edit')).toBeNull();
    expect(screen.queryByText('Holiday')).toBeNull();
  });

  it('a pay cycle that never loaded shows only the header, not a wrong-cycle pace', async () => {
    seedHubWith(server, { goals: [GOAL] });
    server.fail('/paycycle', 500);
    setParams({ id: 'g1' });
    await renderWithQueries(<GoalDetail />);
    expect(screen.queryByTestId('goal-detail-edit')).toBeNull();
    expect(screen.queryByText('Holiday')).toBeNull();
  });

  it('a goal with no milestones has no MILESTONES section', async () => {
    seedHubWith(server, { goals: [GOAL] });
    setParams({ id: 'g1' });
    await renderWithQueries(<GoalDetail />);
    expect(screen.getByText('Holiday')).toBeTruthy();
    expect(screen.queryByText('MILESTONES')).toBeNull();
  });

  it('a goal past its date nudges to pick a new one, and the nudge opens Edit', async () => {
    seedHubWith(server, { goals: [growGoal('late', { name: 'Late one', target_date: '2026-07-01' })] });
    setParams({ id: 'late' });
    await renderWithQueries(<GoalDetail />);
    expect(screen.getByText('Past your date — pick a new one?')).toBeTruthy();
    expect(screen.queryByText(/each payday/)).toBeNull();
    fireEvent.press(screen.getByTestId('goal-pastdue-late'));
    expect(routerSpies.push).toHaveBeenCalledWith('/goal/edit?id=late');
  });
});
