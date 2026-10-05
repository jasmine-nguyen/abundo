// WHIT-748 QA — Goals tab pace pill + dollars line edges the proof test leaves open: the calm
// colour on "Ahead"/"On pace", a sub-dollar "Ahead", an unpolled goal (no line, no pill), a
// paydown judged without a bar (pill only), a goal past its target, and the mortgage card left
// alone. Real balanceGoalView over the fake server; clock pinned to Sat 11 Jul 2026 (start Jun6 →
// target Aug15 = 70 days, 35 elapsed → expected fill 0.5).
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { screen, within } from '@testing-library/react-native';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { pinToday } from './support/clock';
import { styleOf } from './support/layout';
import { seedGoalsHub } from './support/goalsScreen';
import { EMPTY_LOAN_FACTS } from './factory';
import { C, tint } from '../theme';
import type { GoalRecord } from '../api';

jest.mock('../motion/ScrollChromeHeader', () => require('./support/scrollChromeHeaderMock').scrollChromeHeaderMockModule());
jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ openGoalBalance: jest.fn() }) };
});
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }), useFocusEffect: () => {} }));

import Goals from '../../app/(tabs)/goals';

const START = { start_date: '2026-06-06', target_date: '2026-08-15' };
const grow = (id: string, over: Partial<GoalRecord> = {}): GoalRecord => ({
  id, name: `Grow ${id}`, icon: 'wallet', direction: 'grow', target_amount: 10000, target_date: '2026-08-15', account_id: `acct-${id}`, ...over,
});
// 2000 start → 8000: ahead by $2,000. 6000: on pace.
const AHEAD = grow('ahead', { ...START, start_balance: 2000 });
const ON_PACE = grow('onpace', { ...START, start_balance: 2000 });
// target 2, start 0, balance 1.5 → ahead by $0.50 → plain "Ahead".
const TINY = grow('tiny', { target_amount: 2, ...START, start_balance: 0 });
// A start but no balance polled yet → no dollars, no pill.
const UNPOLLED = grow('unpolled', { ...START, start_balance: 2000 });
// Past the target → the bar is full; dollars stop at the target.
const OVER = grow('over');
// Paydown with a start but no baseline: 20000 → 8000 owed, ahead, but no bar scale.
const NO_SCALE: GoalRecord = {
  id: 'noscale', name: 'Card', icon: 'cash', direction: 'paydown', target_amount: 0, account_id: null,
  manual_balance: 8000, manual_as_of: '2026-07-01', ...START, start_balance: 20000,
};

const server = installFakeServer();
useTestQueryClient();

beforeEach(() => {
  resetAuth();
  pinToday(new Date(2026, 6, 11));
  seedGoalsHub(server, {
    goals: [AHEAD, ON_PACE, TINY, UNPOLLED, OVER, NO_SCALE],
    payCycle: { length: 14, last_pay_date: '2026-06-06' },
    balances: { 'acct-ahead': 8000, 'acct-onpace': 6000, 'acct-tiny': 1.5, 'acct-over': 12000 },
    loanFacts: EMPTY_LOAN_FACTS,
    homeLoan: { balance: 596642.43, asOf: '2026-07-04T00:00:00Z' },
  });
});
afterEach(() => { jest.useRealTimers(); });

describe('goal card pace pill + dollars edges (WHIT-748 QA)', () => {
  it('[A12] "Ahead by" and "On pace" use the calm cyan text on a cyan wash, never rose', async () => {
    await renderWithQueries(<Goals />);
    for (const [id, text] of [['ahead', 'Ahead by $2,000'], ['onpace', 'On pace']]) {
      const pill = screen.getByTestId(`goal-pace-${id}`);
      expect(styleOf(within(pill).getByText(text)).color).toBe(C.good);
      expect(styleOf(pill).backgroundColor).toBe(tint(C.good, 0.14));
    }
  });

  it('[A13] a goal ahead by under a dollar reads just "Ahead", not "Ahead by $1" or "$0"', async () => {
    await renderWithQueries(<Goals />);
    const pill = within(screen.getByTestId('goal-pace-tiny'));
    expect(pill.getByText('Ahead')).toBeTruthy();
    expect(pill.queryByText(/Ahead by/)).toBeNull();
  });

  it('[A14] a goal waiting on its balance shows no dollars line and no pill', async () => {
    await renderWithQueries(<Goals />);
    expect(within(screen.getByTestId('goal-card-unpolled')).getByText('Waiting on your balance')).toBeTruthy();
    expect(screen.queryByTestId('goal-amount-unpolled')).toBeNull();
    expect(screen.queryByTestId('goal-pace-unpolled')).toBeNull();
  });

  it('[A15] a paydown judged from its start but with no bar shows the pill and no dollars', async () => {
    await renderWithQueries(<Goals />);
    expect(within(screen.getByTestId('goal-pace-noscale')).getByText('Ahead by $2,000')).toBeTruthy();
    expect(screen.queryByTestId('goal-amount-noscale')).toBeNull();
  });

  it('[A16] a goal past its target shows the target as the dollars moved, matching 100%', async () => {
    await renderWithQueries(<Goals />);
    const card = within(screen.getByTestId('goal-card-over'));
    expect(card.getByText('100%')).toBeTruthy();
    expect(screen.getByTestId('goal-amount-over')).toHaveTextContent('$10,000 of $10,000');
    expect(screen.queryByTestId('goal-pace-over')).toBeNull(); // no start → no judgement
  });

  it('[A17] the home-loan card gets no pill or dollars line', async () => {
    await renderWithQueries(<Goals />);
    expect(screen.queryAllByTestId(/^goal-pace-/).map((n) => n.props.testID).sort())
      .toEqual(['goal-pace-ahead', 'goal-pace-noscale', 'goal-pace-onpace', 'goal-pace-tiny']);
    expect(screen.queryAllByTestId(/^goal-amount-/).map((n) => n.props.testID).sort())
      .toEqual(['goal-amount-ahead', 'goal-amount-onpace', 'goal-amount-over', 'goal-amount-tiny']);
  });
});
