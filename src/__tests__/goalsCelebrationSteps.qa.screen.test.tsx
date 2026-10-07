// WHIT-811 QA — how the Goals hub builds each goal's steps for the celebration, on the real screen
// (real data code, goal engine, hook and banner; server, auth, router, header chrome and
// reduce-motion stubbed): one jump past several milestones names the furthest one, for a grow AND a
// paydown goal (sign-off Q2), and mortgage milestones are tracked by their id, not their position.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { screen } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { installFakeServer } from './support/fakeServer';
import { refreshInAct, renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { resetRouter } from './support/routerMock';
import { pinToday } from './support/clock';
import { seedCelebrationHub } from './support/goalsScreen';
import { queryClient } from '../queryClient';
import type { GoalRecord, MilestoneRecord } from '../api';

jest.mock('../motion/ScrollChromeHeader', () => require('./support/scrollChromeHeaderMock').scrollChromeHeaderMockModule());

jest.mock('../auth', () => require('./support/authMock').authMockModule());

jest.mock('../context', () => require('./support/goalsScreen').goalsContextMockModule());

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

jest.mock('../motion/useReduceMotion', () => ({ useReduceMotion: () => true }));

import Goals from '../../app/(tabs)/goals';

const HOLIDAY: GoalRecord = {
  id: 'g1', name: 'Holiday', icon: 'wallet', direction: 'grow',
  target_amount: 10000, target_date: '2026-08-15', account_id: 'up-spending',
  checkpoints: [{ id: 'a', label: 'Flights booked', amount: 2000 }, { id: 'b', label: 'Hotel paid', amount: 5000 }],
};
// Paydown: the saved order runs from the biggest debt down, so "Halfway" (5000) is further along.
const CAR: GoalRecord = {
  id: 'g3', name: 'Car loan', icon: 'wallet', direction: 'paydown',
  target_amount: 0, target_date: '2026-12-15', account_id: 'up-car',
  checkpoints: [{ id: 'c', label: 'Under 8k', amount: 8000 }, { id: 'd', label: 'Halfway', amount: 5000 }],
};
const FIRST: MilestoneRecord = { id: 'm1', label: 'First', targetBalance: 600000, targetDate: '2027-01-01' };
const SECOND: MilestoneRecord = { id: 'm2', label: 'Second', targetBalance: 500000, targetDate: '2029-01-01' };

const server = installFakeServer();
useTestQueryClient();

const refresh = () => refreshInAct(() => queryClient.invalidateQueries());
const label = () => screen.findByTestId('checkpoint-celebration-label');

beforeEach(async () => {
  await AsyncStorage.clear();
  resetAuth();
  resetRouter();
  pinToday(new Date(2026, 6, 11));
  server.seed('/milestones', []);
});

describe('Goals celebration steps (WHIT-811 QA)', () => {
  // [A1] [A2]
  it.each([
    ['grow', HOLIDAY, 'up-spending', 1000, 6000, /^Holiday · Hotel paid reached/],
    ['paydown', CAR, 'up-car', -9000, -4000, /^Car loan · Halfway reached/],
  ] as const)('a %s goal jumping past two milestones at once celebrates once, naming the furthest', async (_, goal, account, before, after, expected) => {
    seedCelebrationHub(server,[goal], { [account]: before });
    await renderWithQueries(<Goals />);
    expect(screen.queryByTestId('checkpoint-celebration')).toBeNull();

    seedCelebrationHub(server,[goal], { [account]: after });
    await refresh();
    expect(await label()).toHaveTextContent(expected);
  });

  // [A3]
  it('mortgage milestones are tracked by id: delete a cleared one, cross the next → it celebrates', async () => {
    server.seed('/milestones', [FIRST, SECOND]);
    seedCelebrationHub(server,[], {}, 550000); // "First" cleared, "Second" not
    await renderWithQueries(<Goals />);
    expect(screen.queryByTestId('checkpoint-celebration')).toBeNull();

    server.seed('/milestones', [SECOND]); // "Second" is now first in the list
    seedCelebrationHub(server,[], {}, 490000);
    await refresh();
    expect(await label()).toHaveTextContent(/^The mortgage · Second reached/);
  });
});
