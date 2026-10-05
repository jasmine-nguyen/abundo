// WHIT-749 slice 2 — the read-only goal page. Tapping a goal card on the Goals tab opens
// /goal/<id> (not the edit form); the page shows the goal's progress, pace, its milestones (name,
// amount, reached or not) and an Edit button to /goal/edit?id=. No Delete on the page. Through the
// fake server and the REAL balanceGoalView. Clock pinned to Sat 11 Jul 2026 (paydays Jul18, Aug1, Aug15).
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { screen, fireEvent, within } from '@testing-library/react-native';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { pinToday } from './support/clock';
import { seedHubWith } from './support/goalsScreen';
import { GOAL_TODAY, GOAL_START } from './support/goalPace';
import { routerSpies, setParams, resetRouter } from './support/routerMock';
import type { GoalRecord } from '../api';

jest.mock('../motion/ScrollChromeHeader', () => require('./support/scrollChromeHeaderMock').scrollChromeHeaderMockModule());
jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('../context', () => require('./support/goalsScreen').goalsContextMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import Goals from '../../app/(tabs)/goals';
import GoalDetail from '../../app/goal/[id]';

const server = installFakeServer();
useTestQueryClient();

// $5,000 of $10,000 saved, halfway through Jun6 → Aug15 → on pace; $5,000 over 3 paydays.
const GOAL: GoalRecord = {
  id: 'ef 1', name: 'Emergency fund', icon: 'wallet', direction: 'grow', target_amount: 10000,
  account_id: 'up-spending', ...GOAL_START, start_balance: 0,
  checkpoints: [{ id: 'c1', label: 'First buffer', amount: 2000 }, { id: 'c2', label: 'Nearly there', amount: 7500 }],
};

beforeEach(() => {
  resetRouter();
  resetAuth();
  pinToday(GOAL_TODAY);
  seedHubWith(server, { goals: [GOAL], balances: { 'up-spending': 5000 } });
});
afterEach(() => { jest.useRealTimers(); });

describe('Goals tab', () => {
  it('tapping a goal card opens its read-only goal page, not the edit form', async () => {
    await renderWithQueries(<Goals />);
    fireEvent.press(screen.getByTestId('goal-card-ef 1'));
    expect(routerSpies.push).toHaveBeenCalledWith('/goal/ef%201');
    expect(routerSpies.push).not.toHaveBeenCalledWith(expect.stringContaining('/goal/edit'));
  });
});

describe('goal page', () => {
  it('shows progress, pace and each milestone with its reached state, with Edit and no Delete', async () => {
    setParams({ id: 'ef 1' });
    await renderWithQueries(<GoalDetail />);

    expect(screen.getByText('Emergency fund')).toBeTruthy();
    expect(screen.getByText('50%')).toBeTruthy();
    expect(screen.getByText('$5,000 of $10,000')).toBeTruthy();
    expect(within(screen.getByTestId('goal-pace-ef 1')).getByText('On pace')).toBeTruthy();
    expect(screen.getByText('$1,667 / payday')).toBeTruthy();
    expect(screen.getByText('3 paydays left')).toBeTruthy();

    const first = within(screen.getByTestId('goal-milestone-c1'));
    expect(first.getByText('First buffer')).toBeTruthy();
    expect(first.getByText('$2,000')).toBeTruthy();
    expect(screen.getByTestId('goal-milestone-reached-c1')).toBeTruthy();

    const second = within(screen.getByTestId('goal-milestone-c2'));
    expect(second.getByText('Nearly there')).toBeTruthy();
    expect(second.getByText('$7,500')).toBeTruthy();
    expect(screen.queryByTestId('goal-milestone-reached-c2')).toBeNull();

    expect(screen.queryByText(/Delete/)).toBeNull();
    fireEvent.press(screen.getByTestId('goal-detail-edit'));
    expect(routerSpies.push).toHaveBeenCalledWith('/goal/edit?id=ef%201');
  });
});
