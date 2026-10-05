// WHIT-749 slice 1 — calmer goal cards on the Goals tab, through the fake server and the REAL
// balanceGoalView. A goal past its date gets a gentle "pick a new one?" nudge (to Edit) instead of
// "due now" + the whole remainder per payday; a date still ahead but before the next payday reads
// "$X to go · before your next payday"; a pay-down with no start shows "$X owed of $Y target" with
// no bar and no "—"; the checkpoint count says "milestones reached". Clock pinned to Sat 11 Jul 2026.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { screen, fireEvent, within } from '@testing-library/react-native';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { pinToday } from './support/clock';
import { seedGoalsHub, type GoalsHubSeed } from './support/goalsScreen';
import { EMPTY_LOAN_FACTS } from './factory';
import type { GoalRecord } from '../api';

jest.mock('../motion/ScrollChromeHeader', () => require('./support/scrollChromeHeaderMock').scrollChromeHeaderMockModule());

jest.mock('../auth', () => require('./support/authMock').authMockModule());

jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ openGoalBalance: jest.fn() }) };
});

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
  useFocusEffect: () => {},
}));

import Goals from '../../app/(tabs)/goals';

const PAY_CYCLE = { length: 14, last_pay_date: '2026-06-06' }; // paydays …Jul4, Jul18, Aug1, Aug15

const server = installFakeServer();
useTestQueryClient();

const HUB: GoalsHubSeed = { payCycle: PAY_CYCLE, balances: { 'up-spending': 4000 }, loanFacts: EMPTY_LOAN_FACTS, homeLoan: { balance: 596642.43, asOf: '2026-07-04T00:00:00Z' } };
const seedHub = (over: GoalsHubSeed = {}) => seedGoalsHub(server, { ...HUB, ...over });

beforeEach(() => {
  mockPush.mockClear();
  resetAuth();
  pinToday(new Date(2026, 6, 11)); // Sat 11 Jul 2026
  seedHub();
});
afterEach(() => { jest.useRealTimers(); });

describe('goal card: past its date', () => {
  it('shows a calm "pick a new one?" nudge that opens Edit, with no "due now" or "/ payday"', async () => {
    const goal: GoalRecord = { id: 'od', name: 'Emergency fund', icon: 'wallet', direction: 'grow', target_amount: 10000, target_date: '2026-06-01', account_id: 'up-spending' };
    seedHub({ goals: [goal] });
    await renderWithQueries(<Goals />);
    const card = within(screen.getByTestId('goal-card-od'));
    expect(card.getByText('Past your date — pick a new one?')).toBeTruthy();
    expect(card.queryByText('due now')).toBeNull();
    expect(card.queryByText(/\/ payday/)).toBeNull();
    expect(card.getByText('40%')).toBeTruthy();

    fireEvent.press(screen.getByTestId('goal-pastdue-od'));
    expect(mockPush).toHaveBeenCalledWith('/goal/edit?id=od');
  });

  it('a goal already met but past its date gets no nudge', async () => {
    const goal: GoalRecord = { id: 'met', name: 'Holiday', icon: 'wallet', direction: 'grow', target_amount: 3000, target_date: '2026-06-01', account_id: 'up-spending' };
    seedHub({ goals: [goal] });
    await renderWithQueries(<Goals />);
    expect(screen.queryByTestId('goal-pastdue-met')).toBeNull();
    expect(within(screen.getByTestId('goal-card-met')).queryByText('Past your date — pick a new one?')).toBeNull();
  });
});

describe('goal card: date ahead but before the next payday', () => {
  it('reads "$X to go" and "before your next payday", never "due now" or "/ payday"', async () => {
    const goal: GoalRecord = { id: 'soon', name: 'Emergency fund', icon: 'wallet', direction: 'grow', target_amount: 10000, target_date: '2026-07-15', account_id: 'up-spending' };
    seedHub({ goals: [goal] });
    await renderWithQueries(<Goals />);
    const card = within(screen.getByTestId('goal-card-soon'));
    expect(card.getByText('$6,000 to go')).toBeTruthy();
    expect(card.getByText('before your next payday')).toBeTruthy();
    expect(card.queryByText('due now')).toBeNull();
    expect(card.queryByText(/\/ payday/)).toBeNull();
    expect(card.queryByText('Past your date — pick a new one?')).toBeNull();
  });
});

describe('goal card: pay-down with no start balance', () => {
  it('shows "$X owed of $Y target" and no "—"', async () => {
    const goal: GoalRecord = { id: 'nb', name: 'Credit card', icon: 'cash', direction: 'paydown', target_amount: 2000, target_date: '2026-08-15', account_id: null, manual_balance: 9000 };
    seedHub({ goals: [goal] });
    await renderWithQueries(<Goals />);
    const card = within(screen.getByTestId('goal-card-nb'));
    expect(card.getByText('$9,000 owed of $2,000 target')).toBeTruthy();
    expect(card.queryByText('—')).toBeNull();
    expect(card.getByText('$2,333 / payday')).toBeTruthy(); // (9000 − 2000) / 3 paydays, whole dollars
  });

  it('with a $0 target the line just reads "$X owed"', async () => {
    const goal: GoalRecord = { id: 'nz', name: 'Credit card', icon: 'cash', direction: 'paydown', target_amount: 0, target_date: '2026-08-15', account_id: null, manual_balance: 9000 };
    seedHub({ goals: [goal] });
    await renderWithQueries(<Goals />);
    const card = within(screen.getByTestId('goal-card-nz'));
    expect(card.getByText('$9,000 owed')).toBeTruthy();
    expect(card.queryByText(/target/)).toBeNull();
    expect(card.queryByText('—')).toBeNull();
  });
});

describe('goal card: milestones count', () => {
  it('says what was reached: "1 of 2 milestones reached"', async () => {
    const goal: GoalRecord = {
      id: 'cp', name: 'Emergency fund', icon: 'wallet', direction: 'grow', target_amount: 10000, target_date: '2026-08-15', account_id: 'up-spending',
      checkpoints: [{ id: 'c1', label: 'First buffer', amount: 2000 }, { id: 'c2', label: 'Halfway', amount: 5000 }],
    };
    seedHub({ goals: [goal] });
    await renderWithQueries(<Goals />);
    expect(within(screen.getByTestId('goal-card-cp')).getByText('1 of 2 milestones reached')).toBeTruthy();
  });
});
