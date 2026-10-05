// WHIT-749 QA — goal-card foot / amount / bar edges the proof test leaves open: a met goal past its
// date never claims "before your next payday"; a paydown past its date nudges instead of showing the
// whole amount owed; target date = today and = the next payday; a paydown WITH a start keeps "$X of
// $Y"; the bar hides when the balance is unknown; a manual past-due goal keeps "Update balance".
// Real balanceGoalView over the fake server; clock pinned to Sat 11 Jul 2026 (paydays Jul18, Aug1, Aug15).
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { screen, within } from '@testing-library/react-native';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { pinToday } from './support/clock';
import { GOAL_TODAY, growGoal, seedPaceHub } from './support/goalPace';
import type { GoalRecord } from '../api';

jest.mock('../motion/ScrollChromeHeader', () => require('./support/scrollChromeHeaderMock').scrollChromeHeaderMockModule());
jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ openGoalBalance: jest.fn() }) };
});
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }), useFocusEffect: () => {} }));

import Goals from '../../app/(tabs)/goals';

const server = installFakeServer();
useTestQueryClient();

const card = (id: string) => within(screen.getByTestId(`goal-card-${id}`));
const paydown = (id: string, over: Partial<GoalRecord> = {}): GoalRecord => ({
  id, name: `Debt ${id}`, icon: 'cash', direction: 'paydown', target_amount: 2000, target_date: '2026-08-15',
  account_id: null, manual_balance: 9000, manual_as_of: '2026-07-01', ...over,
});
const render = async (goals: GoalRecord[], balances: Record<string, number> = {}) => {
  seedPaceHub(server, goals, balances);
  await renderWithQueries(<Goals />);
};

beforeEach(() => {
  resetAuth();
  pinToday(GOAL_TODAY);
});
afterEach(() => { jest.useRealTimers(); });

describe('goal card foot edges (WHIT-749 QA)', () => {
  // [A9] P0 — a met goal past its date: no nudge, and never the false "before your next payday".
  it('[A9] a met goal past its date has no nudge and no "before your next payday"', async () => {
    await render([growGoal('met', { target_amount: 3000, target_date: '2026-06-01' })], { 'acct-met': 4000 });
    expect(screen.queryByTestId('goal-pastdue-met')).toBeNull();
    expect(card('met').queryByText('before your next payday')).toBeNull();
    expect(card('met').queryByText('due now')).toBeNull();
  });

  // [A10] P0 — a paydown past its date nudges and never shows the whole owed remainder as a pace.
  it('[A10] a paydown past its date shows the nudge, not "$7,000 to go" or "/ payday"', async () => {
    await render([paydown('pd', { target_date: '2026-06-01' })]);
    expect(card('pd').getByText('Past your date — pick a new one?')).toBeTruthy();
    expect(card('pd').queryByText('$7,000 to go')).toBeNull();
    expect(card('pd').queryByText(/\/ payday/)).toBeNull();
    expect(card('pd').getByText('$9,000 owed of $2,000 target')).toBeTruthy();
  });

  // [A11] P1 — target date is today: not past due, 0 paydays → the calm before-payday wording.
  it('[A11] a goal due today reads "$X to go" + "before your next payday", no nudge', async () => {
    await render([growGoal('today', { target_date: '2026-07-11' })], { 'acct-today': 4000 });
    expect(screen.queryByTestId('goal-pastdue-today')).toBeNull();
    expect(card('today').getByText('$6,000 to go')).toBeTruthy();
    expect(card('today').getByText('before your next payday')).toBeTruthy();
  });

  // [A12] P1 — target date = the next payday (Jul 18) counts that payday: "1 payday left" + per-payday.
  it('[A12] a goal due on the next payday keeps "$X / payday" + "1 payday left"', async () => {
    await render([growGoal('next', { target_date: '2026-07-18' })], { 'acct-next': 4000 });
    expect(card('next').getByText('$6,000 / payday')).toBeTruthy();
    expect(card('next').getByText('1 payday left')).toBeTruthy();
    expect(card('next').queryByText('before your next payday')).toBeNull();
  });

  // [A13] P1 — a manual goal past its date still offers "Update balance" under the nudge.
  it('[A13] a manual goal past its date keeps the Update balance row', async () => {
    await render([paydown('man', { target_date: '2026-06-01' })]);
    expect(card('man').getByText('Past your date — pick a new one?')).toBeTruthy();
    expect(card('man').getByText('Update balance')).toBeTruthy();
  });
});

describe('goal card amount + bar edges (WHIT-749 QA)', () => {
  // [A14] P1 — a paydown WITH a start keeps the "$moved of $span" line, not the "owed" form.
  it('[A14] a paydown with a baseline shows "$X of $Y", not "owed"', async () => {
    await render([paydown('base', { baseline: 12000 })]); // 12000 → 2000 span 10000, owed 9000 → moved 3000
    expect(screen.getByTestId('goal-amount-base')).toHaveTextContent('$3,000 of $10,000');
    expect(card('base').queryByText(/owed/)).toBeNull();
    expect(card('base').getByText('30%')).toBeTruthy();
  });

  // [A15] P1 — no-start paydown with a ladder: no bar, so no dots and no count line either.
  it('[A15] a no-start paydown with checkpoints shows no dots and no milestones count', async () => {
    await render([paydown('ladder', { checkpoints: [{ id: 'a', label: 'A', amount: 9500 }, { id: 'b', label: 'B', amount: 5000 }] })]);
    expect(card('ladder').queryAllByTestId('bar-dot')).toHaveLength(0);
    expect(card('ladder').queryAllByTestId('bar-dot-reached')).toHaveLength(0);
    expect(screen.queryByTestId('goal-checkpoints-ladder')).toBeNull();
    expect(screen.getByTestId('goal-amount-ladder')).toHaveTextContent('$9,000 owed of $2,000 target');
  });

  // [A16] P2 — a synced paydown with no start and no balance yet: no "owed" line (no "$0 owed").
  it('[A16] an unpolled no-start paydown shows no amount line, just the waiting foot', async () => {
    await render([paydown('wait', { account_id: 'acct-wait', manual_balance: null })]);
    expect(screen.queryByTestId('goal-amount-wait')).toBeNull();
    expect(card('wait').getByText('Waiting on your balance')).toBeTruthy();
  });

  // [A17] P2 — a synced no-start paydown reads the owed amount off the (negative) live balance.
  it('[A17] a synced no-start paydown shows the owed amount as a positive', async () => {
    await render([paydown('sync', { account_id: 'acct-sync', manual_balance: null })], { 'acct-sync': -4500.4 });
    expect(screen.getByTestId('goal-amount-sync')).toHaveTextContent('$4,500 owed of $2,000 target');
  });

  // [A18] P1 — the "owed" form is pay-down only: a savings goal with no bar scale never says "owed".
  it('[A18] a grow goal with no bar scale shows no "owed" line', async () => {
    await render([growGoal('flat', { baseline: 10000 })], { 'acct-flat': 4000 }); // baseline == target → no scale
    expect(screen.queryByTestId('goal-amount-flat')).toBeNull();
    expect(card('flat').queryByText(/owed/)).toBeNull();
  });
});
