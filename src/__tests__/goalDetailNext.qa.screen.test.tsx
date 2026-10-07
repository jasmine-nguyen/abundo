// WHIT-812 QA — the goal page's "Next" line across a pay-down ladder (incl. all reached and no
// ladder), and the load gate's edges the proof tests leave open: a goals read that fails first time
// (error, never "Goal not found"), a held pay cycle (spinner, never a default-cycle pace), and a
// background refresh failing over a loaded goal (the goal stays up). Through the fake server and
// the REAL balanceGoalView. Clock pinned to Sat 11 Jul 2026.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient, refreshInAct, WithQueries } from './support/renderWithQueries';
import { queryClient } from '../queryClient';
import { goalsKey } from '../queryKeys';
import { resetAuth } from './support/authMock';
import { pinToday } from './support/clock';
import { seedHubWith } from './support/goalsScreen';
import { GOAL_TODAY, GOAL_START, growGoal } from './support/goalPace';
import { setParams, resetRouter } from './support/routerMock';
import type { GoalRecord } from '../api';

jest.mock('../motion/ScrollChromeHeader', () => require('./support/scrollChromeHeaderMock').scrollChromeHeaderMockModule());
jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('../context', () => require('./support/goalsScreen').goalsContextMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import GoalDetail from '../../app/goal/[id]';

const server = installFakeServer();
useTestQueryClient();

// A manual pay-down from $20,000 owed to $0, ladder in climb order (descending owed).
const CARD: GoalRecord = {
  id: 'card', name: 'Credit card', icon: 'wallet', direction: 'paydown', target_amount: 0,
  account_id: null, manual_balance: 9000, manual_as_of: '2026-07-01', baseline: 20000, ...GOAL_START,
  checkpoints: [
    { id: 'm15', label: 'Under fifteen', amount: 15000 },
    { id: 'm10', label: 'Under ten', amount: 10000 },
    { id: 'm5', label: 'Under five', amount: 5000 },
  ],
};
const HOLIDAY = growGoal('g1', { name: 'Holiday' });

beforeEach(() => {
  resetRouter();
  resetAuth();
  pinToday(GOAL_TODAY);
});
afterEach(() => { jest.useRealTimers(); });

describe('goal page Next line', () => {
  // [A1] pay-down: the next un-ticked milestone and what's still owed above it.
  // [A2] every milestone reached → "All milestones reached", no to-go anywhere.
  // [A3] no milestones → no Next line at all.
  it.each([
    { name: 'pay-down mid-ladder', goal: CARD, next: 'Next: Under five · $4,000 to go' },
    { name: 'pay-down every milestone reached', goal: { ...CARD, manual_balance: 4999.5 }, next: 'All milestones reached' },
    { name: 'no milestones', goal: { ...CARD, checkpoints: [] }, next: null },
  ])('$name', async ({ goal, next }) => {
    seedHubWith(server, { goals: [goal] });
    setParams({ id: 'card' });
    await renderWithQueries(<GoalDetail />);
    if (next == null) {
      expect(screen.queryByTestId('goal-detail-next')).toBeNull();
      return;
    }
    expect(screen.getByTestId('goal-detail-next')).toHaveTextContent(next);
  });

  // [A4] the page hides the "N of M reached" count (sign-off Q2), but the milestone dots' scale stays.
  it('the page drops the count line the Next line replaces', async () => {
    seedHubWith(server, { goals: [CARD] });
    setParams({ id: 'card' });
    await renderWithQueries(<GoalDetail />);
    expect(screen.getByTestId('goal-detail-next')).toBeTruthy();
    expect(screen.queryByTestId('goal-checkpoints-card')).toBeNull();
    expect(screen.queryByText(/milestones? reached$/)).toBeNull();
  });
});

describe('goal page load gate', () => {
  // [A5] a goals read failing first time is an error + Retry — never "Goal not found".
  it('a failed first goals read shows an error, not "Goal not found"; Retry then shows the goal', async () => {
    seedHubWith(server, { goals: [HOLIDAY] });
    server.once('GET', '/goals', { status: 500 });
    setParams({ id: 'g1' });
    await renderWithQueries(<GoalDetail />);
    expect(screen.getByTestId('goal-detail-error')).toBeTruthy();
    expect(screen.queryByTestId('goal-detail-missing')).toBeNull();
    expect(screen.queryByTestId('goal-detail-edit')).toBeNull();

    await act(async () => { fireEvent.press(screen.getByTestId('goal-detail-retry')); });
    await waitFor(() => expect(screen.getByText('Holiday')).toBeTruthy());
    expect(screen.queryByTestId('goal-detail-error')).toBeNull();
  });

  // [A6] goals landed but the pay cycle is still in flight → spinner, never a default-cycle pace.
  it('a held pay cycle shows the spinner, not a default-cycle pace, until it lands', async () => {
    seedHubWith(server, { goals: [HOLIDAY] });
    const held = server.hold('/paycycle');
    setParams({ id: 'g1' });
    render(<WithQueries><GoalDetail /></WithQueries>);
    await waitFor(() => expect(queryClient.getQueryData(goalsKey)).toBeTruthy());
    expect(screen.getByTestId('goal-detail-loading')).toBeTruthy();
    expect(screen.queryByText('Holiday')).toBeNull();
    expect(screen.queryByTestId('goal-detail-edit')).toBeNull();
    await act(async () => { held.release(); });
    await waitFor(() => expect(screen.getByText('Holiday')).toBeTruthy());
    expect(screen.queryByTestId('goal-detail-loading')).toBeNull();
  });

  // [A7] a background refresh that fails over a loaded goal keeps the goal up, no error block.
  it('a failed background refresh keeps the loaded goal on screen', async () => {
    seedHubWith(server, { goals: [HOLIDAY] });
    setParams({ id: 'g1' });
    await renderWithQueries(<GoalDetail />);
    server.fail('/goals', 500);
    server.fail('/paycycle', 500);
    await refreshInAct(() => queryClient.refetchQueries());
    await waitFor(() => expect(queryClient.getQueryState(goalsKey)?.status).toBe('error'));
    expect(screen.getByText('Holiday')).toBeTruthy();
    expect(screen.getByTestId('goal-detail-edit')).toBeTruthy();
    expect(screen.queryByTestId('goal-detail-error')).toBeNull();
  });
});
