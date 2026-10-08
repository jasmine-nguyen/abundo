// WHIT-822 — the Home loan screen tells the user what the next milestone unlocks, how far into it
// they are, what to pay each payday to hit it, and how old the balance is. Drawn over the fake server.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { screen, within } from '@testing-library/react-native';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { seedGoal } from './support/goalsScreen';
import { resetRouter } from './support/routerMock';
import { SAVED_MILESTONES } from './support/milestonePlan';
import { screenJson } from './support/pull';
import { pinToday } from './support/clock';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('../context', () => require('./support/contextMock').realContextWith(() => ({})));
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import Mortgage from '../../app/mortgage';

const server = installFakeServer();
useTestQueryClient();

beforeEach(() => {
  resetAuth();
  resetRouter();
  pinToday(new Date(2026, 9, 8, 12)); // Thu 8 Oct 2026, midday local (Melbourne)
});
afterEach(() => { jest.useRealTimers(); });

// $275,000 owing, saved plan Start $300k (cleared) → Midway $200k by Jan 2027 → Payoff $100k.
// LOAN_FACTS: home $770,000 × 0.8 LVR − $200,000 = $416,000 equity at Midway; 5.74% rate.
it.each([
  ['synced yesterday', '2026-10-07T12:00:00Z', 'As of yesterday', false],
  ['a late-evening UTC sync is today in local time', '2026-10-07T20:00:00Z', 'As of today', false],
  ['synced 5 days ago', '2026-10-03T02:00:00Z', 'As of 3 Oct', true],
])('user sees the next milestone’s equity, pace and balance age: %s', async (_case, asOf, label, stale) => {
  seedGoal(server, { milestones: SAVED_MILESTONES, homeLoan: { balance: 275000, asOf } });
  server.seed('/paycycle', { length: 14, last_pay_date: '2026-10-02' });
  await renderWithQueries(<Mortgage />);

  expect(screen.getByText('Next: under $200,000 → unlocks $416,000 equity')).toBeTruthy();
  expect(screen.getByText('$75,000 to go')).toBeTruthy();
  // $275k is a quarter of the way from Start ($300k) to Midway ($200k): that segment fills 25%.
  expect(screenJson()).toContain('"width":"25%"');
  // $26,196.21/month for 3 months at 5.74% lands on $200,000 → × 12 ÷ 26 fortnightly paydays.
  expect(await screen.findByTestId('milestone-pace')).toHaveTextContent('$12,091 per payday to hit Jan 2027');

  expect(within(screen.getByTestId('balance-freshness')).getByText(label)).toBeTruthy();
  expect(screen.queryByTestId('balance-freshness-stale') !== null).toBe(stale);
});
