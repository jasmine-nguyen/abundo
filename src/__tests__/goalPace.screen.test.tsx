// WHIT-748 — the Goals tab's goal card shows a calm pace pill ("On pace" / "Ahead by $X" /
// "A little behind", never the alarm red) and the "$X of $Y" dollars next to the %. Runs the real
// balanceGoalView over the fake server; clock pinned to Sat 11 Jul 2026 (start Jun6 → target Aug15
// = 70 days, 35 elapsed → expected fill 0.5).
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { screen, within } from '@testing-library/react-native';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { pinToday } from './support/clock';
import { styleOf } from './support/layout';
import { GOAL_START, GOAL_TODAY, growGoal, seedPaceHub } from './support/goalPace';
import { C } from '../theme';
import type { GoalRecord } from '../api';

jest.mock('../motion/ScrollChromeHeader', () => require('./support/scrollChromeHeaderMock').scrollChromeHeaderMockModule());
jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ openGoalBalance: jest.fn() }) };
});
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }), useFocusEffect: () => {} }));

import Goals from '../../app/(tabs)/goals';

// No start → no pill. 4000 of 10000.
const PLAIN = growGoal('plain');
// start 2000: 8000 → 0.75 (ahead by 0.25 × 8000 = $2,000); 6000 → 0.5 (on pace).
const AHEAD = growGoal('ahead', { ...GOAL_START, start_balance: 2000 });
const ON_PACE = growGoal('onpace', { ...GOAL_START, start_balance: 2000 });
// Paydown from 20000 owed, now 12000 → 0.4 vs 0.5 → behind; 8000 paid down of 20000.
const DEBT: GoalRecord = {
  id: 'debt', name: 'Car loan', icon: 'car', direction: 'paydown', target_amount: 0, baseline: 20000,
  manual_balance: 12000, manual_as_of: '2026-07-01', account_id: null, ...GOAL_START, start_balance: 20000,
};

const server = installFakeServer();
useTestQueryClient();

beforeEach(() => {
  resetAuth();
  pinToday(GOAL_TODAY);
  seedPaceHub(server, [PLAIN, AHEAD, ON_PACE, DEBT], { 'acct-plain': 4000, 'acct-ahead': 8000, 'acct-onpace': 6000 });
});
afterEach(() => { jest.useRealTimers(); });

describe('goal card pace pill + dollars (WHIT-748)', () => {
  it('a user sees how each goal is pacing, in calm colours, with dollars next to the %', async () => {
    await renderWithQueries(<Goals />);

    expect(within(screen.getByTestId('goal-pace-ahead')).getByText('Ahead by $2,000')).toBeTruthy();
    expect(within(screen.getByTestId('goal-pace-onpace')).getByText('On pace')).toBeTruthy();
    const behind = within(screen.getByTestId('goal-pace-debt')).getByText('A little behind');
    expect(styleOf(behind).color).toBe(C.warn);
    expect(styleOf(behind).color).not.toBe(C.bad);
    expect(screen.queryByTestId('goal-pace-plain')).toBeNull();

    expect(screen.getByTestId('goal-amount-plain')).toHaveTextContent('$4,000 of $10,000');
    expect(screen.getByTestId('goal-amount-debt')).toHaveTextContent('$8,000 of $20,000');

    // The existing footer stays.
    const card = within(screen.getByTestId('goal-card-plain'));
    expect(card.getByText('40%')).toBeTruthy();
    expect(card.getByText('$2,000 / payday')).toBeTruthy();
    expect(card.getByText('3 paydays left')).toBeTruthy();
  });
});
