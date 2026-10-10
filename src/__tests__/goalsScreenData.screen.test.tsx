// WHIT-233 — the Goals hub's composite (useGoalsScreenData) on the REAL query layer: not
// fetched before login, fires on the auth flip, assembles the reads, and the milestones read is
// SECONDARY: it never holds up or errors the hub. (The hub's primary vs secondary read failures
// and Retry are covered on the screen in goalsHub.screen.) Real ../api over the fake server,
// ../auth mocked; real QueryClientProvider.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react-native';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeClient, wrapper } from './support/queryClient';
import { installFakeServer } from './support/fakeServer';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
import { setAuthStatus, setAuthStatusQuietly, resetAuth } from './support/authMock';

import { useGoalsScreenData } from '../queries';

const server = installFakeServer();

const GOALS = [
  { id: 'g1', name: 'Emergency fund', icon: 'umbrella', direction: 'grow', target_amount: 10000, target_date: '2026-12-01', account_id: 'up-spending' },
];
const PAY_CYCLE = { length: 14, last_pay_date: '2026-06-06' };
const BALANCES = [
  { account_id: 'up-spending', amount: 4200.5, available_balance: null, currency: 'AUD', as_of: '2026-07-10T00:00:00Z', account_type: null },
  { account_id: 'up-homeloan', amount: -596642.43, available_balance: null, currency: 'AUD', as_of: '2026-07-10T00:00:00Z', account_type: null },
];
const HOME_LOAN = { balance: 596642.43, as_of: '2026-07-04T00:24:37.614Z', currency: 'AUD' };
const READY_FACTS = { original: 500000, homeValue: 770000, lvr: 0.8, ratePct: 5.74, baseRepay: 1240, extra: 200 };

beforeEach(() => {
  resetAuth();
  server.seed('/goals', GOALS);
  server.seed('/paycycle', PAY_CYCLE);
  server.seed('/accounts/balances', BALANCES);
  server.seed('/homeloan', HOME_LOAN);
  server.seed('/loanfacts', READY_FACTS);
});

it('assembles goals, pay cycle, the mortgage summary, and a per-account balance lookup', async () => {
  const { result } = renderHook(() => useGoalsScreenData(), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(result.current.isLoading).toBe(false));

  expect(result.current.goals).toEqual(GOALS);
  expect(result.current.payCycle).toEqual(PAY_CYCLE);
  expect(result.current.loanFacts).toEqual(READY_FACTS);
  expect(result.current.homeLoan).toEqual({ balance: 596642.43, asOf: '2026-07-04T00:24:37.614Z' });
  expect(result.current.isError).toBe(false);
  expect(result.current.mortgageError).toBe(false);
});

it('balanceFor returns the live SIGNED amount by account id, null for unknown/unset', async () => {
  const { result } = renderHook(() => useGoalsScreenData(), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(result.current.goals).toEqual(GOALS));

  expect(result.current.balanceFor('up-spending')).toBe(4200.5);
  expect(result.current.balanceFor('up-homeloan')).toBe(-596642.43); // sign preserved (a loan is negative)
  expect(result.current.balanceFor('not-linked')).toBeNull();        // account not in the payload
  expect(result.current.balanceFor(null)).toBeNull();                // a manual goal (no account_id)
  expect(result.current.balanceFor(undefined)).toBeNull();
});

it('does not fetch before login, then fires every read on the auth flip', async () => {
  setAuthStatusQuietly('anon');
  const { result } = renderHook(() => useGoalsScreenData(), { wrapper: wrapper(makeClient()) });
  expect(server.sent('GET', '/goals')).toHaveLength(0);
  expect(server.sent('GET', '/paycycle')).toHaveLength(0);
  expect(server.sent('GET', '/accounts/balances')).toHaveLength(0);

  await act(async () => { setAuthStatus('authed'); });
  await waitFor(() => expect(result.current.goals).toEqual(GOALS));
  expect(server.sent('GET', '/goals')).toHaveLength(1);
  expect(server.sent('GET', '/accounts/balances')).toHaveLength(1);
});

it('SECONDARY milestones (WHIT-747): a slow read never holds up the hub, and they arrive once loaded', async () => {
  const MILESTONES = [{ id: 'm1', label: 'First', targetBalance: 600000, targetDate: '2027-01-01' }];
  server.seed('/milestones', MILESTONES);
  const held = server.hold('/milestones');
  const { result } = renderHook(() => useGoalsScreenData(), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(result.current.goals).toEqual(GOALS));

  expect(result.current.isLoading).toBe(false);
  expect(result.current.goalsLoaded).toBe(true);
  expect(result.current.milestonesLoaded).toBe(false);
  expect(result.current.milestones).toEqual([]);

  await act(async () => { held.release(); });
  await waitFor(() => expect(result.current.milestonesLoaded).toBe(true));
  expect(result.current.milestones).toEqual(MILESTONES);
});

it('SECONDARY milestones failure does NOT set isError, and still counts as loaded (an empty plan)', async () => {
  server.fail('/milestones', 500);
  const { result } = renderHook(() => useGoalsScreenData(), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(result.current.milestonesLoaded).toBe(true));

  expect(result.current.isError).toBe(false);
  expect(result.current.milestones).toEqual([]);
});
