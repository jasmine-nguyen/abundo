// WHIT-823 — milestones that haven't loaded (or failed to load) must never look like "no plan":
// the Home loan milestones card and the Milestone detail plan card show a quiet placeholder
// while loading and an error + Retry on a failed first load. The empty invite shows only when
// milestones loaded and are genuinely empty. Drawn over the fake server so the real query code runs.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { screen, act, fireEvent } from '@testing-library/react-native';
import type { AppContext } from '../context';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, refreshInAct, settle, useTestQueryClient, drawHeld, releaseAndSettle } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { seedGoal } from './support/goalsScreen';
import { resetRouter } from './support/routerMock';

let mockState: Partial<AppContext>;
jest.mock('../context', () => require('./support/contextMock').realContextWith(() => mockState));
jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import Mortgage from '../../app/mortgage';
import Milestone from '../../app/milestone';

const server = installFakeServer();
useTestQueryClient();

const INVITE = 'Set your payoff milestones';
const DETAIL_EMPTY = /You haven't set any milestones yet/;
const LOAD_ERROR = "Couldn't load your milestones.";
const HOME_LOAN = { balance: 250000, asOf: '2026-07-04T00:00:00Z' };

beforeEach(() => {
  resetAuth();
  resetRouter();
  mockState = { showToast: jest.fn() as AppContext['showToast'] };
});

it('Home loan: no milestones invite while milestones are still loading', async () => {
  seedGoal(server, { homeLoan: HOME_LOAN });
  const held = server.hold('/milestones');
  drawHeld(<Mortgage />);
  await refreshInAct(() => undefined);
  expect(screen.queryByText(INVITE)).toBeNull();
  expect(screen.getByTestId('milestones-loading')).toBeTruthy();
  await releaseAndSettle(held);
});

it('Home loan: a failed milestones read shows an error + Retry, not the empty invite', async () => {
  seedGoal(server, { homeLoan: HOME_LOAN });
  server.fail('/milestones', 500);
  await renderWithQueries(<Mortgage />);
  expect(screen.queryByText(INVITE)).toBeNull();
  expect(screen.getByText(LOAD_ERROR)).toBeTruthy();
  expect(screen.getByTestId('milestones-retry')).toBeTruthy();
});

it('Home loan: Retry after a failed milestones read brings back the plan card', async () => {
  seedGoal(server, { homeLoan: HOME_LOAN });
  server.once('GET', '/milestones', { status: 500 });
  await renderWithQueries(<Mortgage />);
  await act(async () => { fireEvent.press(screen.getByTestId('milestones-retry')); });
  await settle();
  expect(screen.queryByTestId('milestones-retry')).toBeNull();
  expect(screen.getByText(/milestones reached|Your payoff plan/)).toBeTruthy();
  expect(screen.queryByText(INVITE)).toBeNull();
});

it('Home loan: a genuinely empty plan still shows the invite', async () => {
  seedGoal(server, { homeLoan: HOME_LOAN, milestones: [] });
  await renderWithQueries(<Mortgage />);
  expect(screen.getByText(INVITE)).toBeTruthy();
  expect(screen.queryByText(LOAD_ERROR)).toBeNull();
});

it('Milestone detail: a failed milestones read shows Retry, not the empty state', async () => {
  seedGoal(server, { homeLoan: HOME_LOAN });
  server.fail('/milestones', 500);
  await renderWithQueries(<Milestone />);
  expect(screen.queryByText(DETAIL_EMPTY)).toBeNull();
  expect(screen.getByTestId('milestone-plan-retry')).toBeTruthy();
});

it('Milestone detail: no empty state while milestones are still loading', async () => {
  seedGoal(server, { homeLoan: HOME_LOAN });
  const held = server.hold('/milestones');
  drawHeld(<Milestone />);
  await refreshInAct(() => undefined);
  expect(screen.queryByText(DETAIL_EMPTY)).toBeNull();
  expect(screen.getByTestId('milestone-plan-loading')).toBeTruthy();
  await releaseAndSettle(held);
});

// [A1] the detail screen also reads `refetch` (balance/facts only): its plan-card Retry must reload milestones.
it('Milestone detail: Retry after a failed milestones read brings back the plan', async () => {
  seedGoal(server, { homeLoan: HOME_LOAN });
  server.once('GET', '/milestones', { status: 500 });
  await renderWithQueries(<Milestone />);
  await act(async () => { fireEvent.press(screen.getByTestId('milestone-plan-retry')); });
  await settle();
  expect(screen.queryByTestId('milestone-plan-retry')).toBeNull();
  expect(screen.getByText('Your payoff plan')).toBeTruthy();
});
