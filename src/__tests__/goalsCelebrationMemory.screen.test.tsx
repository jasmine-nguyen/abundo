// WHIT-747 — celebrations that stick. The Goals hub remembers which steps were reached (WHIT-811) on the
// phone (AsyncStorage), so a crossing made while the app was closed celebrates on the next open;
// reaching a goal's target is its final step (celebrated, and the card reads "Goal reached"); and
// the mortgage's milestones take part. The REAL screen data code, goal engine and celebration hook
// run; only the server (fake), auth, router, header chrome and reduce-motion are stubbed. Reduce
// motion is on so the banner shows without the confetti animation.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { screen } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { pinToday } from './support/clock';
import { seedGoalsHub } from './support/goalsScreen';
import { EMPTY_LOAN_FACTS } from './factory';
import { CHECKPOINT_SNAPSHOT_KEY, StepSnapshot } from '../checkpointCelebration';
import { holidaySaved, mortgageSaved } from './support/celebrationSteps';
import type { GoalRecord, MilestoneRecord } from '../api';

jest.mock('../motion/ScrollChromeHeader', () => require('./support/scrollChromeHeaderMock').scrollChromeHeaderMockModule());

jest.mock('../auth', () => require('./support/authMock').authMockModule());

jest.mock('../context', () => require('./support/goalsScreen').goalsContextMockModule());

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

jest.mock('../motion/useReduceMotion', () => ({ useReduceMotion: () => true }));

import Goals from '../../app/(tabs)/goals';

const PAY_CYCLE = { length: 14, last_pay_date: '2026-06-06' };
// A savings goal with two checkpoints ($2,000 and $5,000) and a $10,000 target.
const GOAL: GoalRecord = {
  id: 'g1', name: 'Holiday', icon: 'wallet', direction: 'grow',
  target_amount: 10000, target_date: '2026-08-15', account_id: 'up-spending',
  checkpoints: [{ id: 'a', label: 'A', amount: 2000 }, { id: 'b', label: 'B', amount: 5000 }],
};

const server = installFakeServer();
useTestQueryClient();

function seedHub(balance: number, homeLoanBalance: number | null = null) {
  seedGoalsHub(server, {
    goals: [GOAL], payCycle: PAY_CYCLE, balances: { 'up-spending': balance },
    loanFacts: EMPTY_LOAN_FACTS, homeLoan: { balance: homeLoanBalance, asOf: '2026-07-04T00:00:00Z' },
  });
}

// What an earlier launch of the app saved: goal id → each step it showed, and whether it was reached.
async function savedFromEarlierLaunch(snapshot: StepSnapshot) {
  await AsyncStorage.setItem(CHECKPOINT_SNAPSHOT_KEY, JSON.stringify(snapshot));
}

beforeEach(async () => {
  await AsyncStorage.clear();
  resetAuth();
  pinToday(new Date(2026, 6, 11));
  server.seed('/milestones', []);
});

describe('Goals celebrations that stick (WHIT-747)', () => {
  it('celebrates a checkpoint crossed while the app was closed, naming the milestone', async () => {
    await savedFromEarlierLaunch({ g1: holidaySaved(true, false, false) }); // last open: past $2,000 only
    seedHub(6000);                                                         // since then the bank synced past $5,000

    await renderWithQueries(<Goals />);

    const label = await screen.findByTestId('checkpoint-celebration-label');
    expect(label).toHaveTextContent(/Holiday · B reached/);
  });

  it('celebrates reaching the target and shows "Goal reached" instead of the pace', async () => {
    await savedFromEarlierLaunch({ g1: holidaySaved(true, true, false) }); // last open: both checkpoints, target not yet met
    seedHub(10000);                           // now at the $10,000 target

    await renderWithQueries(<Goals />);

    const label = await screen.findByTestId('checkpoint-celebration-label');
    expect(label).toHaveTextContent(/Holiday · goal reached/i);
    expect(screen.getByTestId('goal-reached-g1')).toHaveTextContent('Goal reached');
    expect(screen.queryByText(/\/ payday/)).toBeNull();
  });

  it('celebrates a mortgage milestone cleared since the last saved copy', async () => {
    const milestones: MilestoneRecord[] = [
      { id: 'm1', label: 'First', targetBalance: 600000, targetDate: '2027-01-01' },
      { id: 'm2', label: 'Second', targetBalance: 500000, targetDate: '2029-01-01' },
    ];
    await savedFromEarlierLaunch({ g1: holidaySaved(true, false, false), mortgage: mortgageSaved(false, false) });
    seedHub(4000, 596642.43); // the goal is unchanged; the loan dropped below $600,000
    server.seed('/milestones', milestones);

    await renderWithQueries(<Goals />);

    const label = await screen.findByTestId('checkpoint-celebration-label');
    expect(label).toHaveTextContent(/The mortgage · First reached/);
  });
});
