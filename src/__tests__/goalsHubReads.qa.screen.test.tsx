// WHIT-685 QA — the Goals tab's read rules, run through the real useGoalsScreenData over the fake
// server: which reads gate the spinner / error (goals + pay cycle only), which only degrade one
// card (balances, home loan, loan facts), a cached home loan surviving a failed refetch, and Retry
// refreshing every read.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { act, render, screen, fireEvent, within, waitFor } from '@testing-library/react-native';
import { installFakeServer } from './support/fakeServer';
import { refreshInAct, renderWithQueries, useTestQueryClient, WithQueries, settle } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { pinToday } from './support/clock';
import { seedGoalsHub, type GoalsHubSeed } from './support/goalsScreen';
import { EMPTY_LOAN_FACTS } from './factory';
import { queryClient } from '../queryClient';
import type { GoalRecord } from '../api';

jest.mock('../motion/ScrollChromeHeader', () => require('./support/scrollChromeHeaderMock').scrollChromeHeaderMockModule());

jest.mock('../auth', () => require('./support/authMock').authMockModule());

jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ openGoalBalance: jest.fn() }) };
});

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn() }),
  useFocusEffect: () => {},
}));

import Goals from '../../app/(tabs)/goals';

const PAY_CYCLE = { length: 14, last_pay_date: '2026-06-06' };
const GROW: GoalRecord = { id: 'g1', name: 'Emergency fund', icon: 'wallet', direction: 'grow', target_amount: 10000, target_date: '2026-08-15', account_id: 'up-spending' };
const READY_FACTS = { original: 800000, homeValue: 900000, lvr: 0.8, ratePct: 5.74, baseRepay: 1240, extra: 200, payoffGoalDate: null };

const server = installFakeServer();
useTestQueryClient();

const HUB: GoalsHubSeed = { payCycle: PAY_CYCLE, balances: { 'up-spending': 4000 }, loanFacts: EMPTY_LOAN_FACTS, homeLoan: { balance: 596642.43, asOf: '2026-07-04T00:00:00Z' } };
const seedHub = (over: GoalsHubSeed = {}) => seedGoalsHub(server, { ...HUB, ...over });

beforeEach(() => {
  resetAuth();
  pinToday(new Date(2026, 6, 11));
  seedHub();
});
afterEach(() => { jest.useRealTimers(); });

describe('secondary reads degrade one card, never the hub', () => {
  // [A1] a balances failure leaves the synced card waiting, the hub drawn and no error.
  it('a failed balances read shows the synced goal as "—" + waiting, with no hub error', async () => {
    seedHub({ goals: [GROW] });
    server.fail('/accounts/balances', 500);
    await renderWithQueries(<Goals />);
    const card = within(screen.getByTestId('goal-card-g1'));
    expect(card.getByText('—')).toBeTruthy();
    expect(card.getByText('Waiting on your balance')).toBeTruthy();
    expect(screen.queryByTestId('goals-error')).toBeNull();
    expect(screen.queryByTestId('goals-loading')).toBeNull();
  });

  // [A1b] with no goals the hub error would show if a secondary read counted as primary.
  it('failed balances, home loan and loan facts reads with no goals still show the invite, not the hub error', async () => {
    server.fail('/accounts/balances', 500);
    server.fail('/homeloan', 500);
    server.fail('/loanfacts', 500);
    await renderWithQueries(<Goals />);
    expect(screen.queryByTestId('goals-error')).toBeNull();
    expect(screen.getByTestId('goals-empty-hint')).toBeTruthy();
    expect(within(screen.getByTestId('mortgage-link')).getByText('Tap to open your payoff plan')).toBeTruthy();
  });

  // [A4] a slow home loan never holds the hub on the spinner.
  it('a held home loan read leaves the goals drawn and the mortgage card on its waiting line', async () => {
    seedHub({ goals: [GROW] });
    const held = server.hold('/homeloan');
    render(<WithQueries><Goals /></WithQueries>);
    await waitFor(() => expect(screen.getByTestId('goal-card-g1')).toBeTruthy());
    expect(screen.queryByTestId('goals-loading')).toBeNull();
    expect(within(screen.getByTestId('mortgage-link')).getByText('Tap to see your payoff plan')).toBeTruthy();
    await act(async () => { held.release(); });
    await waitFor(() => expect(within(screen.getByTestId('mortgage-link')).getByText('$596,642')).toBeTruthy());
  });

  // [A6] a loan-facts failure keeps the plain card (no rich payoff) and the goals.
  it('a failed loan facts read keeps the plain mortgage card and the goals, with no hub error', async () => {
    seedHub({ goals: [GROW], loanFacts: READY_FACTS });
    server.fail('/loanfacts', 500);
    await renderWithQueries(<Goals />);
    const card = within(screen.getByTestId('mortgage-link'));
    expect(card.getByText('$596,642')).toBeTruthy();
    expect(card.queryByText('PAID DOWN SO FAR')).toBeNull();
    expect(screen.getByTestId('goal-card-g1')).toBeTruthy();
    expect(screen.queryByTestId('goals-error')).toBeNull();
  });

  // [A5] mortgageError is first-load only: a cached balance survives a failed refetch.
  it('a cached home loan balance survives a failed refetch (no "Tap to open" error copy)', async () => {
    await renderWithQueries(<Goals />);
    expect(within(screen.getByTestId('mortgage-link')).getByText('$596,642')).toBeTruthy();
    server.fail('/homeloan', 500);
    await refreshInAct(() => queryClient.refetchQueries());
    await settle();
    expect(server.sent('GET', '/homeloan')).toHaveLength(2);
    const card = within(screen.getByTestId('mortgage-link'));
    expect(card.getByText('$596,642')).toBeTruthy();
    expect(card.queryByText('Tap to open your payoff plan')).toBeNull();
  });

  // [A5b] a cached "not polled yet" home loan also survives: it keeps the waiting line, not the error line.
  it('a cached not-yet-polled home loan keeps "Tap to see" after a failed refetch, never "Tap to open"', async () => {
    seedHub({ homeLoan: { balance: null, asOf: null } });
    await renderWithQueries(<Goals />);
    expect(within(screen.getByTestId('mortgage-link')).getByText('Tap to see your payoff plan')).toBeTruthy();
    server.fail('/homeloan', 500);
    await refreshInAct(() => queryClient.refetchQueries());
    await settle();
    expect(server.sent('GET', '/homeloan')).toHaveLength(2);
    const card = within(screen.getByTestId('mortgage-link'));
    expect(card.getByText('Tap to see your payoff plan')).toBeTruthy();
    expect(card.queryByText('Tap to open your payoff plan')).toBeNull();
  });

  // [A8] a balance change on the server reaches the card after a refresh (no stale lookup).
  it('a refreshed balance updates the synced goal card', async () => {
    seedHub({ goals: [GROW] });
    await renderWithQueries(<Goals />);
    expect(within(screen.getByTestId('goal-card-g1')).getByText('40%')).toBeTruthy();
    seedHub({ goals: [GROW], balances: { 'up-spending': 7000 } });
    await refreshInAct(() => queryClient.invalidateQueries());
    await waitFor(() => expect(within(screen.getByTestId('goal-card-g1')).getByText('70%')).toBeTruthy());
  });
});

describe('the pay cycle is a primary read', () => {
  // [A2] a pay cycle failure with nothing cached shows the hub error + Retry.
  it('a failed pay cycle read with no goals shows the error + Retry', async () => {
    server.fail('/paycycle', 500);
    await renderWithQueries(<Goals />);
    expect(screen.getByTestId('goals-error')).toBeTruthy();
    expect(screen.getByTestId('goals-retry')).toBeTruthy();
  });

  // [A3] a held pay cycle keeps the spinner up until it lands.
  it('a held pay cycle read shows the spinner until it lands', async () => {
    const held = server.hold('/paycycle');
    render(<WithQueries><Goals /></WithQueries>);
    await waitFor(() => expect(queryClient.isFetching()).toBe(1)); // every read but the pay cycle has landed
    expect(screen.getByTestId('goals-loading')).toBeTruthy();
    await act(async () => { held.release(); });
    await waitFor(() => expect(screen.getByTestId('goals-empty-hint')).toBeTruthy());
    expect(screen.queryByTestId('goals-loading')).toBeNull();
  });

  // [A9] the server's pay cycle drives the pace (weekly → more paydays → smaller step).
  it('a weekly pay cycle from the server changes the per-payday pace', async () => {
    seedHub({ goals: [GROW], payCycle: { length: 7, last_pay_date: '2026-07-04' } });
    await renderWithQueries(<Goals />);
    const card = within(screen.getByTestId('goal-card-g1'));
    expect(card.queryByText('$2,000 / payday')).toBeNull(); // the fortnightly figure
    expect(card.getByText('5 paydays left')).toBeTruthy();  // weekly from Jul 4, as the real engine counts them to Aug 15
    expect(card.getByText('$1,200 / payday')).toBeTruthy(); // 6,000 over 5 paydays
  });
});

describe('Retry refreshes every read', () => {
  // [A7] Retry fires the secondary reads too, so a failed balance comes back with it.
  it('Retry after a first-load failure refetches goals, pay cycle, balances, home loan and loan facts', async () => {
    seedHub({ goals: [GROW] });
    server.once('GET', '/goals', { status: 500 });
    await renderWithQueries(<Goals />);
    expect(screen.getByTestId('goals-error')).toBeTruthy();
    await refreshInAct(() => fireEvent.press(screen.getByTestId('goals-retry')));
    await waitFor(() => expect(screen.getByTestId('goal-card-g1')).toBeTruthy());
    for (const path of ['/goals', '/paycycle', '/accounts/balances', '/homeloan', '/loanfacts']) {
      expect(server.sent('GET', path).length).toBeGreaterThanOrEqual(2);
    }
  });
});
