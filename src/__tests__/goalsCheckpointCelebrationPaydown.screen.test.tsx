// WHIT-481 — the Goals-hub confetti for the cases the first screen suite skips. That suite is
// grow-ONLY and always reuses the same mockData object; these add: (1) a PAYDOWN goal on a synced
// account, whose debt FALLING past a rung must burst — proving balanceGoalView's paydown reached
// count (current <= amount) drives the confetti the same way growth does; and (2) a plain redraw
// where the goals array is a BRAND-NEW identity but the reached count is unchanged — the memo
// recomputes a fresh celebration steps array, the hook effect re-runs, and it must STILL stay silent.
// The real balanceGoalView + hook + diff run end to end; only the data boundary and router are stubs.
// WHIT-685: the goal and its balance come from the fake server through the real screen data code
// (useGoalsScreenData); a balance move is a re-seeded server reply and a cache refresh, as in the app.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { screen, within } from '@testing-library/react-native';
import { installFakeServer } from './support/fakeServer';
import { refreshInAct, renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { pinToday } from './support/clock';
import { seedGoalsHub } from './support/goalsScreen';
import { EMPTY_LOAN_FACTS } from './factory';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { queryClient } from '../queryClient';
import type { GoalRecord } from '../api';

jest.mock('../motion/ScrollChromeHeader', () => require('./support/scrollChromeHeaderMock').scrollChromeHeaderMockModule());

jest.mock('../auth', () => require('./support/authMock').authMockModule());

const mockOpenGoalBalance = jest.fn();
jest.mock('../context', () => require('./support/goalsScreen').goalsContextMockModule(() => mockOpenGoalBalance));

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

jest.mock('../motion/useReduceMotion', () => ({ useReduceMotion: () => false }));

import Goals from '../../app/(tabs)/goals';

const PAY_CYCLE = { length: 14, last_pay_date: '2026-06-06' };
// A PAYDOWN goal on a synced account. Its checkpoints are amounts-owed rungs: reached when the
// owed balance is AT/BELOW the rung. The synced balance is signed (a debt is negative), so paying
// it down toward zero makes the normalised owed amount fall and cross rungs downward.
const DEBT_GOAL: GoalRecord = {
  id: 'd1', name: 'Car loan', icon: 'car', direction: 'paydown',
  target_amount: 0, target_date: '2026-12-15', account_id: 'up-loan',
  checkpoints: [{ id: 'a', label: 'A', amount: 8000 }, { id: 'b', label: 'B', amount: 5000 }],
};

const server = installFakeServer();
useTestQueryClient();

// `owed` is the positive dollars still owing; the synced feed reports it as a negative balance.
// `others` adds unrelated accounts to the balances list.
function seedOwed(owed: number, others: Record<string, number> = {}) {
  seedGoalsHub(server, {
    goals: [DEBT_GOAL], payCycle: PAY_CYCLE, balances: { 'up-loan': -owed, ...others },
    loanFacts: EMPTY_LOAN_FACTS, homeLoan: { balance: 596642.43, asOf: '2026-07-04T00:00:00Z' },
  });
}

// The server now reports new balances and the screen's data refreshes, as a poll would.
async function moveOwed(owed: number, others: Record<string, number> = {}) {
  seedOwed(owed, others);
  await refreshInAct(() => queryClient.invalidateQueries());
}

beforeEach(async () => {
  await AsyncStorage.clear(); // no snapshot saved by an earlier launch
  resetAuth();
  pinToday(new Date(2026, 6, 11));
  seedOwed(6000); // owe 6000: at/below 8000 rung, above 5000 rung → reached 1
});
afterEach(() => { jest.useRealTimers(); });

describe('checkpoint celebration for a paydown goal + array-identity churn (WHIT-481)', () => {
  it('bursts when a paydown balance falls past a new rung', async () => {
    // [A-P1] owe 6000 (reached 1) → owe 4000 crosses the 5000 rung (reached 2) → one burst.
    await renderWithQueries(<Goals />);                  // seed at reached 1, no burst
    expect(screen.queryByTestId('checkpoint-celebration')).toBeNull();

    await moveOwed(4000);                                 // debt shrinks past the 5000 rung
    expect(screen.getByTestId('checkpoint-celebration')).toBeTruthy();
    expect(screen.getByText(/Car loan · B reached/)).toBeTruthy();
  });

  it('does NOT burst when the debt rises back above a rung (re-arm, not celebrate)', async () => {
    // [A-P2] a paydown balance going the WRONG way (owed increases, reached drops) must be silent.
    await renderWithQueries(<Goals />);                  // owe 6000 → reached 1
    await moveOwed(9000);                                 // owe more: now above the 8000 rung → reached 0
    expect(within(screen.getByTestId('goal-card-d1')).getByText('Set aside $818 each payday')).toBeTruthy(); // 9,000 over 11 paydays
    expect(screen.queryByTestId('checkpoint-celebration')).toBeNull();
  });

  it('does not burst on a redraw that recomputes the counts with the same reached number', async () => {
    // [A-P3] a new account joins the balances list but the SAME owed amount: the balance lookup is
    // rebuilt, so the memo yields a new celebration steps identity and the effect re-runs, yet reached
    // is unchanged → no burst. (An identical refresh can't reach this path: the cache keeps the old
    // data, so nothing recomputes.)
    await renderWithQueries(<Goals />);                  // owe 6000 → reached 1, seeded
    await moveOwed(6000, { 'up-saver': 1500 });           // new balances list, identical owed amount
    expect(server.sent('GET', '/accounts/balances')).toHaveLength(2);
    expect(within(screen.getByTestId('goal-card-d1')).getByText('Set aside $545 each payday')).toBeTruthy(); // 6,000 over 11 paydays
    expect(screen.queryByTestId('checkpoint-celebration')).toBeNull();
  });
});
