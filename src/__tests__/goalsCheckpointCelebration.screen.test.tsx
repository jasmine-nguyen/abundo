// WHIT-481 / WHIT-747 / WHIT-811 / WHIT-817 — the in-app confetti wired into the Goals hub. A burst
// when a balance moves past a new rung; celebrations that stick across launches (the phone's saved
// copy in AsyncStorage); reaching a goal's target as its final step; mortgage milestones tracked by
// id; two goals queueing one banner after the other; an old count-style saved copy migrating
// silently; and the gates that stop a slow or failed read (or another tab being open) from firing a
// false celebration or wiping the saved copy. The REAL screen data code, balanceGoalView and
// celebration hook/diff run; only the server (fake), auth, router, header chrome and reduce-motion
// are stubbed.
// Timers stay real (only today's date is pinned), except in the test that shows a burst with motion
// on: it moves the balance on a fully fake clock, so the confetti animation never ticks outside act.
// The saved snapshot is cleared before each test (a brand-new install).
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { act, render, screen } from '@testing-library/react-native';
import { installFakeServer } from './support/fakeServer';
import { refreshInAct, renderWithQueries, useTestQueryClient, WithQueries } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { resetRouter, setFocused } from './support/routerMock';
import { pinToday } from './support/clock';
import { seedCelebrationHub } from './support/goalsScreen';
import { savedCelebrationSnapshot as saved, savedFromEarlierLaunch } from './support/celebrationSnapshot';
import { holidaySaved, mortgageSaved } from './support/celebrationSteps';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { queryClient } from '../queryClient';
import type { GoalRecord, MilestoneRecord } from '../api';

jest.mock('../motion/ScrollChromeHeader', () => require('./support/scrollChromeHeaderMock').scrollChromeHeaderMockModule());

jest.mock('../auth', () => require('./support/authMock').authMockModule());

const mockOpenGoalBalance = jest.fn();
jest.mock('../context', () => require('./support/goalsScreen').goalsContextMockModule(() => mockOpenGoalBalance));

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

let mockReduceMotion = false;
jest.mock('../motion/useReduceMotion', () => ({ useReduceMotion: () => mockReduceMotion }));

import Goals from '../../app/(tabs)/goals';

// A grow goal on a synced account: checkpoints $2,000 and $5,000 and a $10,000 target → up to 3 steps.
const HOLIDAY: GoalRecord = {
  id: 'g1', name: 'Holiday', icon: 'wallet', direction: 'grow',
  target_amount: 10000, target_date: '2026-08-15', account_id: 'up-spending',
  checkpoints: [{ id: 'a', label: 'A', amount: 2000 }, { id: 'b', label: 'B', amount: 5000 }],
};
const BIKE: GoalRecord = {
  id: 'g2', name: 'Bike', icon: 'wallet', direction: 'grow',
  target_amount: 1000, target_date: '2026-08-15', account_id: 'up-bike', checkpoints: [],
};
const MILESTONES: MilestoneRecord[] = [
  { id: 'm1', label: 'First', targetBalance: 600000, targetDate: '2027-01-01' },
  { id: 'm2', label: 'Second', targetBalance: 500000, targetDate: '2029-01-01' },
];
const HOLIDAY_AT_4000 = holidaySaved(true, false, false); // past $2,000 only

const server = installFakeServer();
useTestQueryClient();

const seedHub = (goals: GoalRecord[], balances: Record<string, number>, homeLoanBalance: number | null = 596642.43) =>
  seedCelebrationHub(server, goals, balances, homeLoanBalance);

// The server now reports new data and the screen's data refreshes, as a poll would.
const refresh = () => refreshInAct(() => queryClient.invalidateQueries());

beforeEach(async () => {
  await AsyncStorage.clear(); // no snapshot saved by an earlier launch
  resetAuth();
  mockReduceMotion = false;
  resetRouter();
  pinToday(new Date(2026, 6, 11));
  seedHub([HOLIDAY], { 'up-spending': 4000 }); // past the 2000 rung, not the 5000 rung → reached 1
});
afterEach(() => { jest.useRealTimers(); });

describe('checkpoint celebration on the Goals hub (WHIT-481)', () => {
  it('bursts once when a balance moves past a new rung', async () => {
    await renderWithQueries(<Goals />);              // seed at reached 1, no burst
    expect(screen.queryByTestId('checkpoint-celebration')).toBeNull();

    // 4000 → 6000 crosses the 5000 rung (reached 2), on a fully fake clock.
    jest.useFakeTimers({ now: new Date(2026, 6, 11) });
    seedHub([HOLIDAY], { 'up-spending': 6000 });
    await refresh();
    expect(screen.getByTestId('checkpoint-celebration')).toBeTruthy();
    expect(screen.getByText(/Holiday · B reached/)).toBeTruthy();
  });
});

// Reduce motion is on here, so the banner shows without the confetti animation ticking outside act.
describe('Goals celebrations that stick (WHIT-747 / WHIT-811)', () => {
  beforeEach(() => {
    mockReduceMotion = true;
    server.seed('/milestones', []);
  });

  it('[A1] a brand-new install opening on a finished goal stays silent, shows "Goal reached", and saves its steps', async () => {
    seedHub([HOLIDAY], { 'up-spending': 10000 }); // both checkpoints + the target → 3 steps
    await renderWithQueries(<Goals />);
    expect(screen.queryByTestId('checkpoint-celebration')).toBeNull();
    expect(screen.getByTestId('goal-reached-g1')).toHaveTextContent('Goal reached');
    expect(await saved()).toEqual({ g1: holidaySaved(true, true, true) });
  });

  it('[A2] remembers across a full relaunch: a crossing made while the app was closed celebrates on the next open', async () => {
    const firstLaunch = await renderWithQueries(<Goals />); // first-ever launch at $4,000 → saves g1: 1
    firstLaunch.unmount();
    queryClient.clear();                                     // the app is closed: nothing in memory survives
    seedHub([HOLIDAY], { 'up-spending': 6000 });             // the bank syncs past $5,000 meanwhile
    await renderWithQueries(<Goals />);
    expect(await screen.findByTestId('checkpoint-celebration-label')).toHaveTextContent(/Holiday · B reached/);
  });

  it('[A3] a goal with NO checkpoints celebrates reaching its target (sign-off Q2)', async () => {
    seedHub([BIKE], { 'up-bike': 400 });
    await renderWithQueries(<Goals />);
    expect(await saved()).toEqual({ g2: { 'target@1000': false } });

    seedHub([BIKE], { 'up-bike': 1000 });
    await refresh();
    expect(await screen.findByTestId('checkpoint-celebration-label')).toHaveTextContent(/Bike · goal reached/);
    expect(screen.getByTestId('goal-reached-g2')).toBeTruthy();
  });

  it('celebrates reaching the target and shows "Goal reached" instead of the pace', async () => {
    await savedFromEarlierLaunch({ g1: holidaySaved(true, true, false) }); // last open: both checkpoints, target not yet met
    seedHub([HOLIDAY], { 'up-spending': 10000 }, null);                    // now at the $10,000 target

    await renderWithQueries(<Goals />);

    const label = await screen.findByTestId('checkpoint-celebration-label');
    expect(label).toHaveTextContent(/Holiday · goal reached/i);
    expect(screen.getByTestId('goal-reached-g1')).toHaveTextContent('Goal reached');
    expect(screen.queryByText(/each payday/)).toBeNull();
  });

  it('celebrates a mortgage milestone cleared since the last saved copy', async () => {
    await savedFromEarlierLaunch({ g1: HOLIDAY_AT_4000, mortgage: mortgageSaved(false, false) });
    server.seed('/milestones', MILESTONES); // the goal is unchanged; the loan dropped below $600,000

    await renderWithQueries(<Goals />);

    const label = await screen.findByTestId('checkpoint-celebration-label');
    expect(label).toHaveTextContent(/Home loan · First reached/);
  });

  it('[A7] a failed milestones read keeps the saved mortgage count, so recovering never fires a false celebration', async () => {
    await savedFromEarlierLaunch({ g1: HOLIDAY_AT_4000, mortgage: mortgageSaved(true, false) });
    server.fail('/milestones', 500);
    await renderWithQueries(<Goals />);
    expect(screen.queryByTestId('checkpoint-celebration')).toBeNull();
    expect(await saved()).toEqual({ g1: HOLIDAY_AT_4000, mortgage: mortgageSaved(true, false) });
  });

  it('[A8] an unknown home-loan balance keeps the saved mortgage count', async () => {
    await savedFromEarlierLaunch({ g1: HOLIDAY_AT_4000, mortgage: mortgageSaved(true, false) });
    server.seed('/milestones', MILESTONES);
    seedHub([HOLIDAY], { 'up-spending': 4000 }, null);
    await renderWithQueries(<Goals />);
    expect(screen.queryByTestId('checkpoint-celebration')).toBeNull();
    expect(await saved()).toEqual({ g1: HOLIDAY_AT_4000, mortgage: mortgageSaved(true, false) });
  });

  it('[A9] opening the app on another tab neither celebrates nor overwrites the saved copy until Goals is in view', async () => {
    await savedFromEarlierLaunch({ g1: HOLIDAY_AT_4000 });
    seedHub([HOLIDAY], { 'up-spending': 6000 });
    setFocused(false);
    const view = await renderWithQueries(<Goals />);
    expect(screen.queryByTestId('checkpoint-celebration')).toBeNull();
    expect(await saved()).toEqual({ g1: HOLIDAY_AT_4000 });

    setFocused(true);
    await act(async () => { view.rerender(<WithQueries><Goals /></WithQueries>); });
    expect(await screen.findByTestId('checkpoint-celebration-label')).toHaveTextContent(/Holiday · B reached/);
  });

  it('[A11] a slow milestones read holds the comparison, then celebrates the cleared mortgage milestone', async () => {
    await savedFromEarlierLaunch({ g1: HOLIDAY_AT_4000, mortgage: mortgageSaved(false, false) });
    server.seed('/milestones', MILESTONES);
    const held = server.hold('/milestones');
    render(<WithQueries><Goals /></WithQueries>);
    await screen.findByText('Holiday');               // the goals are on screen; the milestones still loading
    expect(screen.queryByTestId('checkpoint-celebration')).toBeNull();
    expect(await saved()).toEqual({ g1: HOLIDAY_AT_4000, mortgage: mortgageSaved(false, false) });

    await refreshInAct(() => held.release());
    expect(await screen.findByTestId('checkpoint-celebration-label')).toHaveTextContent(/Home loan · First reached/);
    expect(await saved()).toEqual({ g1: HOLIDAY_AT_4000, mortgage: mortgageSaved(true, false) });
  });

  it('two goals crossing in one refresh both celebrate, one banner after the other', async () => {
    seedHub([HOLIDAY, BIKE], { 'up-spending': 4000, 'up-bike': 400 });
    await renderWithQueries(<Goals />);

    seedHub([HOLIDAY, BIKE], { 'up-spending': 6000, 'up-bike': 1000 });
    await refresh();

    expect(await screen.findByTestId('checkpoint-celebration-label')).toHaveTextContent(/^Holiday · /);
    // The banner stays 2.4s, then the queued one shows.
    expect(await screen.findByText(/Bike · goal reached/)).toBeTruthy();
  }, 10000);

  it('an old count-style saved copy switches over silently (all currently reached counts as seen)', async () => {
    await savedFromEarlierLaunch({ g1: 1 });
    seedHub([HOLIDAY], { 'up-spending': 6000 }); // both milestones reached now
    await renderWithQueries(<Goals />);
    await refresh();

    expect(screen.queryByTestId('checkpoint-celebration')).toBeNull();
    expect(typeof (await saved()).g1).toBe('object');
  });

  it('mortgage milestones are tracked by id: delete a cleared one, cross the next → it celebrates', async () => {
    server.seed('/milestones', MILESTONES);
    seedHub([], {}, 550000); // "First" cleared, "Second" not
    await renderWithQueries(<Goals />);
    expect(screen.queryByTestId('checkpoint-celebration')).toBeNull();

    server.seed('/milestones', [MILESTONES[1]]); // "Second" is now first in the list
    seedHub([], {}, 490000);
    await refresh();
    expect(await screen.findByTestId('checkpoint-celebration-label')).toHaveTextContent(/^Home loan · Second reached/);
  });
});

// WHIT-817 — the steps come from checkpointProgress. A pay-down goal whose milestones were saved out
// of order (5k before 8k) crosses both in one balance move: the banner must name the furthest one in
// climb order (5k), not the last one in saved order (8k). Motion stays on (the default).
describe('Goals-tab celebration for milestones saved out of order (WHIT-817)', () => {
  const DEBT_GOAL_SAVED_OUT_OF_ORDER: GoalRecord = {
    id: 'd1', name: 'Car loan', icon: 'car', direction: 'paydown',
    target_amount: 0, target_date: '2026-12-15', account_id: 'up-loan',
    checkpoints: [{ id: 'b', label: 'Under five', amount: 5000 }, { id: 'a', label: 'Under eight', amount: 8000 }],
  };
  const seedOwed = (owed: number) => seedHub([DEBT_GOAL_SAVED_OUT_OF_ORDER], { 'up-loan': -owed });

  beforeEach(() => { seedOwed(9000); }); // above both milestones → none reached

  it('names the closest-to-target milestone when one move crosses two', async () => {
    await renderWithQueries(<Goals />);
    expect(screen.queryByTestId('checkpoint-celebration')).toBeNull();

    seedOwed(4000); // crosses 8000 and 5000 at once
    await refresh();
    expect(screen.getByText(/Car loan · Under five reached/)).toBeTruthy();
  });
});
