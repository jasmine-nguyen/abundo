// WHIT-749 QA — the goal page's edges the proof tests leave open: a pay-down goal's milestones
// tick as the owed amount falls, an unknown balance ticks nothing, a no-start pay-down shows
// "owed of target" with no %, a met goal past its date isn't nudged, the page follows the cache
// (a cold load, an edit, a delete elsewhere), and the card's nudge opens Edit, not the page.
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
import { routerSpies, setParams, resetRouter } from './support/routerMock';
import type { GoalRecord } from '../api';

jest.mock('../motion/ScrollChromeHeader', () => require('./support/scrollChromeHeaderMock').scrollChromeHeaderMockModule());
jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ openGoalBalance: jest.fn() }) };
});
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import Goals from '../../app/(tabs)/goals';
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

  // [A2] exactly at a milestone's amount counts as reached.
  it('a balance exactly at a milestone amount ticks it', async () => {
    await openPage([{ ...CARD, manual_balance: 5000 }], 'card');
    expect(reached('m5')).toBeTruthy();
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
    expect(screen.getByText('Waiting on your balance')).toBeTruthy();
  });
});

describe('goal page progress', () => {
  // [A4] no-start pay-down: no %, no "—", amount reads "owed of target".
  it('a pay-down with no start shows "$X owed of $Y target" and no headline %', async () => {
    await openPage([{ ...CARD, baseline: null, target_amount: 2000, checkpoints: [] }], 'card');
    expect(screen.getByTestId('goal-amount-card').props.children).toBe('$9,000 owed of $2,000 target');
    expect(screen.queryByText(/%$/)).toBeNull();
    expect(screen.queryByText('—')).toBeNull();
  });

  // [A5] a met goal past its date is not nudged to pick a new date.
  it('a met goal past its date shows no "pick a new one?" nudge', async () => {
    await openPage([{ ...CARD, manual_balance: 0, target_date: '2026-07-01' }], 'card');
    expect(screen.getByText('Credit card')).toBeTruthy();
    expect(screen.queryByTestId('goal-pastdue-card')).toBeNull();
  });

  // [A6] date ahead but before the next payday (Jul 18): calm "to go" wording, no "/ payday".
  it('a date before the next payday reads "$X to go · before your next payday"', async () => {
    await openPage([{ ...CARD, target_date: '2026-07-15' }], 'card');
    expect(screen.getByText('$9,000 to go')).toBeTruthy();
    expect(screen.getByText('before your next payday')).toBeTruthy();
    expect(screen.queryByText(/\/ payday/)).toBeNull();
    expect(screen.queryByTestId('goal-pastdue-card')).toBeNull();
  });
});

describe('goal page follows the cache', () => {
  // [A7] cold load: header only while goals are in flight, then the goal fills in.
  it('shows the goal once a slow goals read lands', async () => {
    seedHubWith(server, { goals: [CARD] });
    const held = server.hold('/goals');
    setParams({ id: 'card' });
    render(<WithQueries><GoalDetail /></WithQueries>);
    expect(screen.getByText('Goal')).toBeTruthy();
    expect(screen.queryByText('Credit card')).toBeNull();
    await act(async () => { held.release(); });
    await waitFor(() => expect(screen.getByText('Credit card')).toBeTruthy());
    expect(screen.getByTestId('goal-detail-edit')).toBeTruthy();
  });

  // [A8] an edit saved elsewhere (the cache upsert saveGoal does) shows on return from Edit.
  it('reflects a goal edit written to the goals cache', async () => {
    await openPage([CARD], 'card');
    await refreshInAct(() =>
      queryClient.setQueryData<GoalRecord[]>(goalsKey, (prev) => (prev ?? []).map((g) => ({ ...g, name: 'Visa card' }))));
    expect(screen.getByText('Visa card')).toBeTruthy();
  });

  // [A9] the goal removed from the cache (deleted) → header-only, no stale Edit to a dead id.
  it('drops to header-only when the goal leaves the cache', async () => {
    await openPage([CARD], 'card');
    await refreshInAct(() => queryClient.setQueryData<GoalRecord[]>(goalsKey, []));
    expect(screen.queryByText('Credit card')).toBeNull();
    expect(screen.queryByTestId('goal-detail-edit')).toBeNull();
  });
});

describe('Goals tab', () => {
  // [A10] the card's past-date nudge opens Edit, and does NOT also open the goal page.
  it('the past-date nudge on a card opens Edit, not the goal page', async () => {
    seedHubWith(server, { goals: [{ ...CARD, target_date: '2026-07-01' }] });
    await renderWithQueries(<Goals />);
    fireEvent.press(screen.getByTestId('goal-pastdue-card'));
    expect(routerSpies.push).toHaveBeenCalledTimes(1);
    expect(routerSpies.push).toHaveBeenCalledWith('/goal/edit?id=card');
  });
});
