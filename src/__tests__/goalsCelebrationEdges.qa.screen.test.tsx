// WHIT-747 QA — the edges of "celebrations that stick" on the real Goals hub: what is (and isn't)
// written to the phone's saved copy, a full relaunch, a goal with no checkpoints, the "Goal reached"
// footer, and the gates that stop a slow or failed read (or another tab being open) from firing a
// false celebration or wiping the saved copy. The real screen data code, goal engine and celebration
// hook run; only the server (fake), auth, router, header chrome and reduce-motion are stubbed.
// Reduce motion is on, so the banner shows without the confetti animation ticking outside act.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { act, render, screen } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { installFakeServer } from './support/fakeServer';
import { refreshInAct, renderWithQueries, useTestQueryClient, WithQueries } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { resetRouter, setFocused } from './support/routerMock';
import { pinToday } from './support/clock';
import { seedGoalsHub } from './support/goalsScreen';
import { EMPTY_LOAN_FACTS } from './factory';
import { queryClient } from '../queryClient';
import { CHECKPOINT_SNAPSHOT_KEY } from '../checkpointCelebration';
import type { GoalRecord, MilestoneRecord } from '../api';

jest.mock('../motion/ScrollChromeHeader', () => require('./support/scrollChromeHeaderMock').scrollChromeHeaderMockModule());

jest.mock('../auth', () => require('./support/authMock').authMockModule());

jest.mock('../context', () => require('./support/goalsScreen').goalsContextMockModule());

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

jest.mock('../motion/useReduceMotion', () => ({ useReduceMotion: () => true }));

import Goals from '../../app/(tabs)/goals';

const PAY_CYCLE = { length: 14, last_pay_date: '2026-06-06' };
// Two checkpoints ($2,000, $5,000) and a $10,000 target → up to 3 steps.
const HOLIDAY: GoalRecord = {
  id: 'g1', name: 'Holiday', icon: 'wallet', direction: 'grow',
  target_amount: 10000, target_date: '2026-08-15', account_id: 'up-spending',
  checkpoints: [{ id: 'a', label: 'A', amount: 2000 }, { id: 'b', label: 'B', amount: 5000 }],
};
const BIKE: GoalRecord = {
  id: 'g2', name: 'Bike', icon: 'wallet', direction: 'grow',
  target_amount: 1000, target_date: '2026-08-15', account_id: 'up-bike', checkpoints: [],
};
const CAR: GoalRecord = {
  id: 'g3', name: 'Car loan', icon: 'wallet', direction: 'paydown',
  target_amount: 0, target_date: '2026-08-15', account_id: 'up-car', checkpoints: [],
};
const MILESTONES: MilestoneRecord[] = [
  { id: 'm1', label: 'First', targetBalance: 600000, targetDate: '2027-01-01' },
  { id: 'm2', label: 'Second', targetBalance: 500000, targetDate: '2029-01-01' },
];

const server = installFakeServer();
useTestQueryClient();

function seedHub(goals: GoalRecord[], balances: Record<string, number>, homeLoanBalance: number | null = 596642.43) {
  seedGoalsHub(server, {
    goals, payCycle: PAY_CYCLE, balances,
    loanFacts: EMPTY_LOAN_FACTS, homeLoan: { balance: homeLoanBalance, asOf: '2026-07-04T00:00:00Z' },
  });
}

const saved = async () => JSON.parse((await AsyncStorage.getItem(CHECKPOINT_SNAPSHOT_KEY)) ?? 'null');
const savedFromEarlierLaunch = (snapshot: Record<string, number>) =>
  AsyncStorage.setItem(CHECKPOINT_SNAPSHOT_KEY, JSON.stringify(snapshot));

beforeEach(async () => {
  await AsyncStorage.clear();
  resetAuth();
  resetRouter();
  pinToday(new Date(2026, 6, 11));
  server.seed('/milestones', []);
  seedHub([HOLIDAY], { 'up-spending': 4000 }); // past $2,000 only → 1 step
});

describe('Goals celebrations that stick: edges (WHIT-747 QA)', () => {
  it('[A1] a brand-new install opening on a finished goal stays silent, shows "Goal reached", and saves its steps', async () => {
    seedHub([HOLIDAY], { 'up-spending': 10000 }); // both checkpoints + the target → 3 steps
    await renderWithQueries(<Goals />);
    expect(screen.queryByTestId('checkpoint-celebration')).toBeNull();
    expect(screen.getByTestId('goal-reached-g1')).toHaveTextContent('Goal reached');
    expect(await saved()).toEqual({ g1: 3 });
  });

  it('[A2] remembers across a full relaunch: a crossing made while the app was closed celebrates on the next open', async () => {
    const firstLaunch = await renderWithQueries(<Goals />); // first-ever launch at $4,000 → saves g1: 1
    firstLaunch.unmount();
    queryClient.clear();                                     // the app is closed: nothing in memory survives
    seedHub([HOLIDAY], { 'up-spending': 6000 });             // the bank syncs past $5,000 meanwhile
    await renderWithQueries(<Goals />);
    expect(await screen.findByTestId('checkpoint-celebration-label')).toHaveTextContent(/Holiday · \$5,000 reached/);
  });

  it('[A3] a goal with NO checkpoints celebrates reaching its target (sign-off Q2)', async () => {
    seedHub([BIKE], { 'up-bike': 400 });
    await renderWithQueries(<Goals />);
    expect(await saved()).toEqual({ g2: 0 });

    seedHub([BIKE], { 'up-bike': 1000 });
    await refreshInAct(() => queryClient.invalidateQueries());
    expect(await screen.findByTestId('checkpoint-celebration-label')).toHaveTextContent(/Bike · goal reached/);
    expect(screen.getByTestId('goal-reached-g2')).toBeTruthy();
  });

  it('[A4] a paid-off debt goal reads "Goal reached" instead of its pace', async () => {
    seedHub([CAR], { 'up-car': 0 });
    await renderWithQueries(<Goals />);
    expect(screen.getByTestId('goal-reached-g3')).toHaveTextContent('Goal reached');
    expect(screen.queryByText(/each payday/)).toBeNull();
  });

  it('[A5] a goal below its target keeps the pace line and no "Goal reached"', async () => {
    await renderWithQueries(<Goals />); // $4,000 of $10,000
    expect(screen.queryByTestId('goal-reached-g1')).toBeNull();
    expect(screen.getByText(/each payday/)).toBeTruthy();
  });

  it('[A6] a goal whose balance is unknown reads "Waiting on your balance", never "Goal reached"', async () => {
    seedHub([HOLIDAY], {}); // the account dropped out of the balances reply
    await renderWithQueries(<Goals />);
    expect(screen.queryByTestId('goal-reached-g1')).toBeNull();
    expect(screen.getByText('Waiting on your balance')).toBeTruthy();
  });

  it('[A7] a failed milestones read keeps the saved mortgage count, so recovering never fires a false celebration', async () => {
    await savedFromEarlierLaunch({ g1: 1, mortgage: 1 });
    server.fail('/milestones', 500);
    await renderWithQueries(<Goals />);
    expect(screen.queryByTestId('checkpoint-celebration')).toBeNull();
    expect(await saved()).toEqual({ g1: 1, mortgage: 1 });
  });

  it('[A8] an unknown home-loan balance keeps the saved mortgage count', async () => {
    await savedFromEarlierLaunch({ g1: 1, mortgage: 1 });
    server.seed('/milestones', MILESTONES);
    seedHub([HOLIDAY], { 'up-spending': 4000 }, null);
    await renderWithQueries(<Goals />);
    expect(screen.queryByTestId('checkpoint-celebration')).toBeNull();
    expect(await saved()).toEqual({ g1: 1, mortgage: 1 });
  });

  it('[A9] opening the app on another tab neither celebrates nor overwrites the saved copy until Goals is in view', async () => {
    await savedFromEarlierLaunch({ g1: 1 });
    seedHub([HOLIDAY], { 'up-spending': 6000 });
    setFocused(false);
    const view = await renderWithQueries(<Goals />);
    expect(screen.queryByTestId('checkpoint-celebration')).toBeNull();
    expect(await saved()).toEqual({ g1: 1 });

    setFocused(true);
    await act(async () => { view.rerender(<WithQueries><Goals /></WithQueries>); });
    expect(await screen.findByTestId('checkpoint-celebration-label')).toHaveTextContent(/Holiday · \$5,000 reached/);
  });

  it('[A10] the mortgage seeds silently on a fresh install and is saved under "mortgage"', async () => {
    server.seed('/milestones', MILESTONES);
    await renderWithQueries(<Goals />);
    expect(screen.queryByTestId('checkpoint-celebration')).toBeNull();
    expect(await saved()).toEqual({ g1: 1, mortgage: 1 });
  });

  it('[A11] a slow milestones read holds the comparison, then celebrates the cleared mortgage milestone', async () => {
    await savedFromEarlierLaunch({ g1: 1, mortgage: 0 });
    server.seed('/milestones', MILESTONES);
    const held = server.hold('/milestones');
    render(<WithQueries><Goals /></WithQueries>);
    await screen.findByText('Holiday');               // the goals are on screen; the milestones still loading
    expect(screen.queryByTestId('checkpoint-celebration')).toBeNull();
    expect(await saved()).toEqual({ g1: 1, mortgage: 0 });

    await refreshInAct(() => held.release());
    expect(await screen.findByTestId('checkpoint-celebration-label')).toHaveTextContent(/Home loan · down to \$600,000/);
    expect(await saved()).toEqual({ g1: 1, mortgage: 1 });
  });
});
