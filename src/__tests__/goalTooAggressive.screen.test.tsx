// WHIT-215 — GAP screen test: the "too soon" hint is DERIVED from the selector each render,
// not sticky. The implementer's goals.paydown.screen.test.tsx locks the three static
// renders (hint under the figure / hint replacing static / no hint when realistic). This
// adds the dynamic case they didn't: editing the goal date to a realistic one must CLEAR
// the hint on the next render. Fake clock pinned to 2026-07-04.
// WHIT-685: drawn over the fake server, so the real screen data code runs.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { screen } from '@testing-library/react-native';
import { installFakeServer } from './support/fakeServer';
import { refreshInAct, renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { resetRouter } from './support/routerMock';
import { pinToday } from './support/clock';
import { seedGoal } from './support/goalsScreen';
import {  } from './support/routerMock';
import { queryClient } from '../queryClient';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({}) };
});
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import Mortgage from '../../app/mortgage';

const SET_FACTS = { original: 600000, homeValue: 770000, lvr: 0.8, ratePct: 5.74, baseRepay: 3667, extra: 500, payoffGoalDate: null };

const server = installFakeServer();
useTestQueryClient();

beforeEach(() => {
  resetAuth();
  resetRouter();
  pinToday(new Date(2026, 6, 4));
});
afterEach(() => { jest.useRealTimers(); });

it('editing the goal date from too-soon to realistic CLEARS the hint on re-render (WHIT-215, NEW)', async () => {
  // Start too-soon: 6 months out on a 900k 'none' loan → hint shown.
  seedGoal(server, {
    homeLoan: { balance: 900000, asOf: null },
    loanFacts: { ...SET_FACTS, payoffGoalDate: '2027-01-01' },
  });
  await renderWithQueries(<Mortgage />);
  expect(screen.getByTestId('goal-too-aggressive-hint')).toBeTruthy();

  // User pushes the goal date out to a realistic one; the very next render must drop the hint.
  seedGoal(server, {
    homeLoan: { balance: 900000, asOf: null },
    loanFacts: { ...SET_FACTS, payoffGoalDate: '2035-06-01' },
  });
  await refreshInAct(() => queryClient.invalidateQueries());
  expect(screen.queryByTestId('goal-too-aggressive-hint')).toBeNull();
  // The honest figure still renders — the loan is still 'none', just no longer too soon.
  expect(screen.getByText(/To clear it by Jun 2035 you'd need .* more than now\./)).toBeTruthy();
});
