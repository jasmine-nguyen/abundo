// WHIT-811 — the Goals hub remembers WHICH milestones were reached, not how many. On the real Goals
// screen (real data code, goal engine, celebration hook and banner; only the server, auth, router,
// header chrome and reduce-motion are stubbed):
//  - a milestone added below the balance is already reached → no confetti
//  - deleting a reached milestone and crossing the next one still celebrates
//  - two goals crossing in one refresh both celebrate, one banner after the other
//  - the banner names the milestone by its label
//  - an old count-style saved copy switches over silently
// Each "last look" is made by opening the screen first, so these don't depend on the saved shape.
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
import { savedCelebrationSnapshot, savedFromEarlierLaunch } from './support/celebrationSnapshot';
import { queryClient } from '../queryClient';
import type { GoalRecord } from '../api';

jest.mock('../motion/ScrollChromeHeader', () => require('./support/scrollChromeHeaderMock').scrollChromeHeaderMockModule());

jest.mock('../auth', () => require('./support/authMock').authMockModule());

jest.mock('../context', () => require('./support/goalsScreen').goalsContextMockModule());

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

jest.mock('../motion/useReduceMotion', () => ({ useReduceMotion: () => true }));

import Goals from '../../app/(tabs)/goals';

const FLIGHTS = { id: 'a', label: 'Flights booked', amount: 2000 };
const HOTEL = { id: 'b', label: 'Hotel paid', amount: 5000 };
const HOLIDAY: GoalRecord = {
  id: 'g1', name: 'Holiday', icon: 'wallet', direction: 'grow',
  target_amount: 10000, target_date: '2026-08-15', account_id: 'up-spending',
  checkpoints: [FLIGHTS, HOTEL],
};
const BIKE: GoalRecord = {
  id: 'g2', name: 'Bike', icon: 'wallet', direction: 'grow',
  target_amount: 1000, target_date: '2026-08-15', account_id: 'up-bike', checkpoints: [],
};

const server = installFakeServer();
useTestQueryClient();

const refresh = () => refreshInAct(() => queryClient.invalidateQueries());
const banner = () => screen.queryByTestId('checkpoint-celebration');

beforeEach(async () => {
  await AsyncStorage.clear();
  resetAuth();
  resetRouter();
  pinToday(new Date(2026, 6, 11));
  server.seed('/milestones', []);
});

describe('Goals celebrations remember which milestones were reached (WHIT-811)', () => {
  it('adding a milestone below the balance is already reached → no confetti', async () => {
    seedCelebrationHub(server,[HOLIDAY], { 'up-spending': 4000 }); // past "Flights booked" only
    await renderWithQueries(<Goals />);
    expect(banner()).toBeNull();

    const added = { ...HOLIDAY, checkpoints: [FLIGHTS, { id: 'c', label: 'Passport', amount: 3000 }, HOTEL] };
    seedCelebrationHub(server,[added], { 'up-spending': 4000 }); // same balance, a new milestone under it
    await refresh();

    expect(banner()).toBeNull();
  });

  it('lowering a milestone below the balance → no confetti', async () => {
    seedCelebrationHub(server,[HOLIDAY], { 'up-spending': 4000 });
    await renderWithQueries(<Goals />);

    const lowered = { ...HOLIDAY, checkpoints: [FLIGHTS, { ...HOTEL, amount: 3000 }] };
    seedCelebrationHub(server,[lowered], { 'up-spending': 4000 });
    await refresh();

    expect(banner()).toBeNull();
  });

  it('deleting a reached milestone then crossing the next one still celebrates it', async () => {
    seedCelebrationHub(server,[HOLIDAY], { 'up-spending': 4000 }); // "Flights booked" reached, "Hotel paid" not
    await renderWithQueries(<Goals />);

    seedCelebrationHub(server,[{ ...HOLIDAY, checkpoints: [HOTEL] }], { 'up-spending': 6000 }); // deleted one, crossed the other
    await refresh();

    expect(await screen.findByTestId('checkpoint-celebration-label')).toHaveTextContent(/Holiday · Hotel paid reached/);
  });

  it('two goals crossing in one refresh both celebrate, one banner after the other', async () => {
    seedCelebrationHub(server,[HOLIDAY, BIKE], { 'up-spending': 4000, 'up-bike': 400 });
    await renderWithQueries(<Goals />);

    seedCelebrationHub(server,[HOLIDAY, BIKE], { 'up-spending': 6000, 'up-bike': 1000 });
    await refresh();

    expect(await screen.findByTestId('checkpoint-celebration-label')).toHaveTextContent(/^Holiday · /);
    // The banner stays 2.4s, then the queued one shows.
    expect(await screen.findByText(/Bike · goal reached/, {}, { timeout: 4000 })).toBeTruthy();
  }, 10000);

  it('an old count-style saved copy switches over silently (all currently reached counts as seen)', async () => {
    await savedFromEarlierLaunch({ g1: 1 });
    seedCelebrationHub(server,[HOLIDAY], { 'up-spending': 6000 }); // both milestones reached now
    await renderWithQueries(<Goals />);
    await refresh();

    expect(banner()).toBeNull();
    const saved = await savedCelebrationSnapshot();
    expect(typeof saved.g1).toBe('object');
  });
});
