// WHIT-822 QA — when the Home loan screen must NOT show the pace line or the balance-age pill.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { screen } from '@testing-library/react-native';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { seedGoal } from './support/goalsScreen';
import { resetRouter } from './support/routerMock';
import { SAVED_MILESTONES } from './support/milestonePlan';
import { pinToday } from './support/clock';
import { EMPTY_LOAN_FACTS } from './factory';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('../context', () => require('./support/contextMock').realContextWith(() => ({})));
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import Mortgage from '../../app/mortgage';

const server = installFakeServer();
useTestQueryClient();

beforeEach(() => {
  resetAuth();
  resetRouter();
  pinToday(new Date(2026, 9, 8, 12));
});
afterEach(() => { jest.useRealTimers(); });

const HOME_LOAN = { balance: 275000, asOf: '2026-10-07T12:00:00Z' };

// [A4] usePayCycle falls back to a default cycle on error — the pace must not use it.
it('a pay cycle that fails to load hides the pace line but keeps the next milestone', async () => {
  seedGoal(server, { milestones: SAVED_MILESTONES, homeLoan: HOME_LOAN });
  server.fail('/paycycle', 500);
  await renderWithQueries(<Mortgage />);
  expect(await screen.findByText('Next: under $200,000 → unlocks $416,000 equity')).toBeTruthy();
  expect(screen.queryByTestId('milestone-pace')).toBeNull();
});

// [A5] Sign-off Q1: hidden until loan details are set up. No equity known → no "unlocks".
it('loan details not set up: no pace line and no "unlocks" text, but the balance age shows', async () => {
  seedGoal(server, { milestones: SAVED_MILESTONES, homeLoan: HOME_LOAN, loanFacts: EMPTY_LOAN_FACTS });
  server.seed('/paycycle', { length: 14, last_pay_date: '2026-10-02' });
  await renderWithQueries(<Mortgage />);
  expect(await screen.findByText('Next: under $200,000')).toBeTruthy();
  expect(screen.queryByTestId('milestone-pace')).toBeNull();
  expect(screen.getByTestId('balance-freshness')).toBeTruthy();
});
