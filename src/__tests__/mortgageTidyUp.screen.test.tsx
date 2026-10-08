// WHIT-822 slice 1 — Home loan screen tidy-up: pull-to-refresh, "milestones" wording, emoji-free copy.
// The real screen data code over the fake server.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { act, screen, waitFor } from '@testing-library/react-native';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { resetRouter } from './support/routerMock';
import { seedGoal } from './support/goalsScreen';
import { SAVED_MILESTONES } from './support/milestonePlan';
import { pullControl, screenJson } from './support/pull';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('../context', () => require('./support/contextMock').realContextWith(() => ({})));
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import Mortgage from '../../app/mortgage';

const server = installFakeServer();
useTestQueryClient();

beforeEach(() => {
  resetAuth();
  resetRouter();
});

it('user can pull down on Home loan to reload the balance', async () => {
  seedGoal(server, { milestones: SAVED_MILESTONES, homeLoan: { balance: 432900, asOf: '2026-07-04T00:00:00Z' } });
  await renderWithQueries(<Mortgage />);
  expect(screen.getByText('$432,900 to go')).toBeTruthy();

  seedGoal(server, { milestones: SAVED_MILESTONES, homeLoan: { balance: 430000, asOf: '2026-07-05T00:00:00Z' } });
  const held = server.hold('/homeloan');
  act(() => { pullControl().props.onRefresh(); });
  await waitFor(() => expect(pullControl().props.refreshing).toBe(true));

  held.release();
  await waitFor(() => expect(pullControl().props.refreshing).toBe(false));
  expect(await screen.findByText('$430,000 to go')).toBeTruthy();
});

it('the milestones card says "milestones" (never "sprints") and the screen shows no emoji', async () => {
  // 250k clears only 'Start' (300k) of the 3 saved rows → 1 of 3. Default loan facts are set, so the
  // payoff mini-cards and the contribution card render too.
  seedGoal(server, { milestones: SAVED_MILESTONES, homeLoan: { balance: 250000, asOf: '2026-07-04T00:24:37.614Z' } });
  await renderWithQueries(<Mortgage />);
  expect(screen.getByText('1 of 3 milestones reached')).toBeTruthy();
  expect(screen.getByText('Milestones')).toBeTruthy();
  expect(screen.getByText(/Every extra dollar comes straight off what you owe\./)).toBeTruthy();

  const tree = screenJson();
  expect(tree).not.toMatch(/sprint/i);
  expect(tree).not.toMatch(/\p{Extended_Pictographic}/u);
});
