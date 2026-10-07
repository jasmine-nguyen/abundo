// WHIT-814 — the Goals tab: pull down to reload, and one add button once goals exist.
// Real ScrollChromeHeader (it hands the RefreshControl through) and the real screen data code over
// the fake server.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { act, screen, waitFor } from '@testing-library/react-native';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient } from './support/renderWithQueries';
import { renderWithApp } from './support/renderWithApp';
import { resetAuth } from './support/authMock';
import { resetRouter } from './support/routerMock';
import { pinToday } from './support/clock';
import { seedHubWith } from './support/goalsScreen';
import { pullControl } from './support/pull';
import type { GoalRecord } from '../api';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

import Goals from '../../app/(tabs)/goals';

const server = installFakeServer();
useTestQueryClient();

const EMERGENCY: GoalRecord = { id: 'g1', name: 'Emergency fund', icon: 'wallet', direction: 'grow', target_amount: 10000, target_date: '2026-08-15', account_id: 'up-spending' };
const HOLIDAY: GoalRecord = { id: 'g2', name: 'Japan trip', icon: 'wallet', direction: 'grow', target_amount: 6000, target_date: '2026-08-15', account_id: 'up-spending' };

beforeEach(() => {
  resetAuth();
  resetRouter();
  pinToday(new Date(2026, 6, 11)); // Sat 11 Jul 2026
});

it('user can pull down on Goals to reload, and a goal added elsewhere appears once the spinner clears', async () => {
  seedHubWith(server, { goals: [EMERGENCY] });
  await renderWithApp(<Goals />);
  expect(screen.getByText('Emergency fund')).toBeTruthy();
  expect(screen.queryByText('Japan trip')).toBeNull();

  seedHubWith(server, { goals: [EMERGENCY, HOLIDAY] });
  const held = server.hold('/goals');
  act(() => { pullControl().props.onRefresh(); });
  await waitFor(() => expect(pullControl().props.refreshing).toBe(true));

  held.release();
  await waitFor(() => expect(pullControl().props.refreshing).toBe(false));
  expect(await screen.findByText('Japan trip')).toBeTruthy();
});

// The empty state (header "+" plus the dashed row) is covered by goalsHub.screen.test.tsx.
it('with goals, Goals shows only one add button: the header "+"', async () => {
  seedHubWith(server, { goals: [EMERGENCY] });
  await renderWithApp(<Goals />);
  expect(screen.getByTestId('add-goal')).toBeTruthy();
  expect(screen.queryByTestId('add-goal-cta')).toBeNull();
});
