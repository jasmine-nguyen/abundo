// WHIT-812 — the goal page shows the next milestone and what's left on each, and a manually tracked
// goal can update its balance from the page. Through the fake server and the REAL balanceGoalView.
// Clock pinned to Sat 11 Jul 2026.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { screen, fireEvent, within } from '@testing-library/react-native';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { pinToday } from './support/clock';
import { seedHubWith } from './support/goalsScreen';
import { GOAL_TODAY, GOAL_START } from './support/goalPace';
import { setParams, resetRouter } from './support/routerMock';
import type { GoalRecord } from '../api';

jest.mock('../motion/ScrollChromeHeader', () => require('./support/scrollChromeHeaderMock').scrollChromeHeaderMockModule());
jest.mock('../auth', () => require('./support/authMock').authMockModule());
const mockOpenGoalBalance = jest.fn();
jest.mock('../context', () => require('./support/goalsScreen').goalsContextMockModule(() => mockOpenGoalBalance));
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import GoalDetail from '../../app/goal/[id]';

const server = installFakeServer();
useTestQueryClient();

// A manually tracked savings goal with $2,999.50 saved: the first milestone is reached, the next two
// are $2,001 (rounded up) and $4,501 away.
const BUFFER: GoalRecord = {
  id: 'buf', name: 'Buffer', icon: 'wallet', direction: 'grow', target_amount: 10000,
  account_id: null, manual_balance: 2999.5, manual_as_of: '2026-07-01', ...GOAL_START, start_balance: 0,
  checkpoints: [
    { id: 'c1', label: 'Small buffer', amount: 2000 },
    { id: 'c2', label: 'Big buffer', amount: 5000 },
    { id: 'c3', label: 'Nearly there', amount: 7500 },
  ],
};

beforeEach(() => {
  resetRouter();
  resetAuth();
  pinToday(GOAL_TODAY);
  mockOpenGoalBalance.mockClear();
});
afterEach(() => { jest.useRealTimers(); });

describe('goal page milestones', () => {
  it('shows the next milestone, what is left on each, and lets a manual goal update its balance', async () => {
    seedHubWith(server, { goals: [BUFFER] });
    setParams({ id: 'buf' });
    await renderWithQueries(<GoalDetail />);

    expect(screen.getByTestId('goal-detail-next')).toHaveTextContent('Next: Big buffer · $2,001 to go');
    expect(screen.queryByTestId('goal-checkpoints-buf')).toBeNull();

    expect(screen.getByTestId('goal-milestone-reached-c1')).toBeTruthy();
    expect(screen.queryByTestId('goal-milestone-togo-c1')).toBeNull();
    expect(within(screen.getByTestId('goal-milestone-c2')).getByTestId('goal-milestone-togo-c2')).toHaveTextContent('$2,001 to go');
    expect(within(screen.getByTestId('goal-milestone-c3')).getByTestId('goal-milestone-togo-c3')).toHaveTextContent('$4,501 to go');

    expect(screen.getByText('Balance as of 1 Jul 2026')).toBeTruthy();
    fireEvent.press(screen.getByTestId('goal-balance-buf'));
    expect(mockOpenGoalBalance).toHaveBeenCalledWith('buf');
  });
});
