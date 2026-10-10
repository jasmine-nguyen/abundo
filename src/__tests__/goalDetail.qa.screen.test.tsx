// WHIT-749 QA — the goal page's edges the proof tests leave open: a pay-down goal's milestones
// tick as the owed amount falls, an unknown balance ticks nothing, and the page follows the cache
// (a cold load, an edit, a delete elsewhere).
// Through the fake server and the REAL balanceGoalView. Clock pinned to Sat 11 Jul 2026.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { act, render, screen, fireEvent, within, waitFor } from '@testing-library/react-native';
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

// A manual pay-down from $20,000 owed to $0; $9,000 owed now. Milestones listed out of amount order
// on purpose, so a tick keyed to the wrong row would show.
const CARD: GoalRecord = {
  id: 'card', name: 'Credit card', icon: 'wallet', direction: 'paydown', target_amount: 0,
  account_id: null, manual_balance: 9000, manual_as_of: '2026-07-01', baseline: 20000, ...GOAL_START,
  checkpoints: [
    { id: 'm5', label: 'Under five', amount: 5000 },
    { id: 'm15', label: 'Under fifteen', amount: 15000 },
    { id: 'm10', label: 'Under ten', amount: 10000 },
  ],
};

const reached = (id: string) => screen.queryByTestId(`goal-milestone-reached-${id}`);

beforeEach(() => {
  resetRouter();
  resetAuth();
  pinToday(GOAL_TODAY);
});
afterEach(() => { jest.useRealTimers(); });

async function openPage(goals: GoalRecord[], id: string, balances?: Record<string, number>) {
  seedHubWith(server, balances ? { goals, balances } : { goals });
  setParams({ id });
  await renderWithQueries(<GoalDetail />);
}

describe('goal page milestones', () => {
  // [A1] pay-down ticks a milestone once the owed amount is AT/below it, keyed to the right row.
  it('a pay-down ticks each milestone the owed amount has fallen below, row by row', async () => {
    await openPage([CARD], 'card');
    expect(reached('m15')).toBeTruthy();
    expect(reached('m10')).toBeTruthy();
    expect(reached('m5')).toBeNull();
    expect(within(screen.getByTestId('goal-milestone-m5')).getByText('Under five')).toBeTruthy();
    expect(within(screen.getByTestId('goal-milestone-m5')).getByText('$5,000')).toBeTruthy();
  });

  // [A3] balance unknown → the list still shows, nothing ticked, the foot waits honestly.
  it('a synced goal whose balance is unknown lists its milestones with none ticked', async () => {
    const goal = growGoal('g', {
      name: 'Holiday', account_id: 'missing-acct',
      checkpoints: [{ id: 'c1', label: 'Flights', amount: 1 }],
    });
    await openPage([goal], 'g');
    expect(screen.getByText('Flights')).toBeTruthy();
    expect(reached('c1')).toBeNull();
    expect(screen.queryByTestId('goal-milestone-togo-c1')).toBeNull();
    expect(screen.queryByTestId('goal-detail-next')).toBeNull();
    expect(screen.getByText('Waiting on your balance')).toBeTruthy();
  });
});

describe('goal page follows the cache', () => {
  // [A7] cold load: a spinner (not "Goal not found") while goals are in flight, then the goal fills in.
  it('shows a spinner, then the goal once a slow goals read lands', async () => {
    seedHubWith(server, { goals: [CARD] });
    const held = server.hold('/goals');
    setParams({ id: 'card' });
    render(<WithQueries><GoalDetail /></WithQueries>);
    expect(screen.getByTestId('goal-detail-loading')).toBeTruthy();
    expect(screen.queryByTestId('goal-detail-missing')).toBeNull();
    expect(screen.queryByText('Credit card')).toBeNull();
    await act(async () => { held.release(); });
    await waitFor(() => expect(screen.getByText('Credit card')).toBeTruthy());
    expect(screen.queryByTestId('goal-detail-loading')).toBeNull();
    expect(screen.getByTestId('goal-detail-edit')).toBeTruthy();
  });

  // [A8] an edit saved elsewhere (the cache upsert saveGoal does) shows on return from Edit.
  it('reflects a goal edit written to the goals cache', async () => {
    await openPage([CARD], 'card');
    await refreshInAct(() =>
      queryClient.setQueryData<GoalRecord[]>(goalsKey, (prev) => (prev ?? []).map((g) => ({ ...g, name: 'Visa card' }))));
    expect(screen.getByText('Visa card')).toBeTruthy();
  });

  // [A9] the goal removed from the cache (deleted) → "Goal not found", no stale Edit to a dead id.
  it('shows "Goal not found" when the goal leaves the cache', async () => {
    await openPage([CARD], 'card');
    await refreshInAct(() => queryClient.setQueryData<GoalRecord[]>(goalsKey, []));
    expect(screen.getByTestId('goal-detail-missing')).toBeTruthy();
    expect(screen.queryByText('Credit card')).toBeNull();
    expect(screen.queryByTestId('goal-detail-edit')).toBeNull();
  });
});

// WHIT-812 — the Next line on a pay-down ladder in climb order (descending owed).
const CARD_CLIMB: GoalRecord = {
  ...CARD,
  checkpoints: [
    { id: 'm15', label: 'Under fifteen', amount: 15000 },
    { id: 'm10', label: 'Under ten', amount: 10000 },
    { id: 'm5', label: 'Under five', amount: 5000 },
  ],
};
const HOLIDAY = growGoal('g1', { name: 'Holiday' });

describe('goal page Next line', () => {
  // [N1] pay-down: the next un-ticked milestone and what's still owed above it.
  // [N2] every milestone reached → "All milestones reached".
  // [N3] no milestones → no Next line at all.
  it.each([
    { name: 'pay-down mid-ladder', goal: CARD_CLIMB, next: 'Next: Under five · $4,000 to go' },
    { name: 'pay-down every milestone reached', goal: { ...CARD_CLIMB, manual_balance: 4999.5 }, next: 'All milestones reached' },
    { name: 'no milestones', goal: { ...CARD_CLIMB, checkpoints: [] }, next: null },
  ])('$name', async ({ goal, next }) => {
    await openPage([goal], 'card');
    if (next == null) {
      expect(screen.queryByTestId('goal-detail-next')).toBeNull();
      return;
    }
    expect(screen.getByTestId('goal-detail-next')).toHaveTextContent(next);
  });
});

describe('goal page load gate', () => {
  // [N4] a goals read failing first time is an error + Retry — never "Goal not found".
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

  // [N5] goals landed but the pay cycle is still in flight → spinner, never a default-cycle pace.
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

  // [N6] a background refresh that fails over a loaded goal keeps the goal up, no error block.
  it('a failed background refresh keeps the loaded goal on screen', async () => {
    await openPage([HOLIDAY], 'g1');
    server.fail('/goals', 500);
    server.fail('/paycycle', 500);
    await refreshInAct(() => queryClient.refetchQueries());
    await waitFor(() => expect(queryClient.getQueryState(goalsKey)?.status).toBe('error'));
    expect(screen.getByText('Holiday')).toBeTruthy();
    expect(screen.getByTestId('goal-detail-edit')).toBeTruthy();
    expect(screen.queryByTestId('goal-detail-error')).toBeNull();
  });
});
