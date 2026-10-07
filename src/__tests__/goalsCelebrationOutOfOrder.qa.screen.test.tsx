// WHIT-817 — the Goals-tab confetti now takes its steps from checkpointProgress. A pay-down goal
// whose milestones were saved out of order (5k before 8k) crosses both in one balance move: the
// banner must name the furthest one in climb order (5k), not the last one in saved order (8k).
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { screen } from '@testing-library/react-native';
import { installFakeServer } from './support/fakeServer';
import { refreshInAct, renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { pinToday } from './support/clock';
import { seedGoalsHub } from './support/goalsScreen';
import { EMPTY_LOAN_FACTS } from './factory';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { queryClient } from '../queryClient';
import type { GoalRecord } from '../api';

jest.mock('../motion/ScrollChromeHeader', () => require('./support/scrollChromeHeaderMock').scrollChromeHeaderMockModule());
jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('../context', () => require('./support/goalsScreen').goalsContextMockModule(() => jest.fn()));
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());
jest.mock('../motion/useReduceMotion', () => ({ useReduceMotion: () => false }));

import Goals from '../../app/(tabs)/goals';

const DEBT_GOAL_SAVED_OUT_OF_ORDER: GoalRecord = {
  id: 'd1', name: 'Car loan', icon: 'car', direction: 'paydown',
  target_amount: 0, target_date: '2026-12-15', account_id: 'up-loan',
  checkpoints: [{ id: 'b', label: 'Under five', amount: 5000 }, { id: 'a', label: 'Under eight', amount: 8000 }],
};

const server = installFakeServer();
useTestQueryClient();

function seedOwed(owed: number) {
  seedGoalsHub(server, {
    goals: [DEBT_GOAL_SAVED_OUT_OF_ORDER], payCycle: { length: 14, last_pay_date: '2026-06-06' },
    balances: { 'up-loan': -owed }, loanFacts: EMPTY_LOAN_FACTS,
    homeLoan: { balance: 596642.43, asOf: '2026-07-04T00:00:00Z' },
  });
}

beforeEach(async () => {
  await AsyncStorage.clear();
  resetAuth();
  pinToday(new Date(2026, 6, 11));
  seedOwed(9000); // above both milestones → none reached
});
afterEach(() => { jest.useRealTimers(); });

describe('Goals-tab celebration for milestones saved out of order (WHIT-817)', () => {
  it('names the closest-to-target milestone when one move crosses two', async () => {
    // [A2]
    await renderWithQueries(<Goals />);
    expect(screen.queryByTestId('checkpoint-celebration')).toBeNull();

    seedOwed(4000); // crosses 8000 and 5000 at once
    await refreshInAct(() => queryClient.invalidateQueries());
    expect(screen.getByText(/Car loan · Under five reached/)).toBeTruthy();
  });
});
