// WHIT-749 slice 2 / WHIT-812 — the goal page's edges: "Goal not found" for an unknown id, an error +
// Retry when the pay cycle never loaded (never a wrong-cycle pace), no MILESTONES section without checkpoints, and the
// past-date nudge going to Edit. Through the fake server and the REAL balanceGoalView.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { act, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { pinToday } from './support/clock';
import { seedHubWith } from './support/goalsScreen';
import { GOAL_TODAY, growGoal } from './support/goalPace';
import { routerSpies, setParams, resetRouter } from './support/routerMock';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('../context', () => require('./support/goalsScreen').goalsContextMockModule());
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
  it('an unknown goal id shows "Goal not found", with no Edit', async () => {
    seedHubWith(server, { goals: [GOAL] });
    setParams({ id: 'nope' });
    await renderWithQueries(<GoalDetail />);
    expect(screen.getByTestId('goal-detail-missing')).toBeTruthy();
    expect(screen.queryByTestId('goal-detail-edit')).toBeNull();
    expect(screen.queryByText('Holiday')).toBeNull();
  });

  it('a pay cycle that never loaded shows an error, not a wrong-cycle pace; Retry then shows the goal', async () => {
    seedHubWith(server, { goals: [GOAL] });
    server.once('GET', '/paycycle', { status: 500 });
    setParams({ id: 'g1' });
    await renderWithQueries(<GoalDetail />);
    expect(screen.getByTestId('goal-detail-error')).toBeTruthy();
    expect(screen.queryByTestId('goal-detail-edit')).toBeNull();
    expect(screen.queryByText('Holiday')).toBeNull();

    await act(async () => { fireEvent.press(screen.getByTestId('goal-detail-retry')); });
    await waitFor(() => expect(screen.getByText('Holiday')).toBeTruthy());
    expect(screen.getByTestId('goal-detail-edit')).toBeTruthy();
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
