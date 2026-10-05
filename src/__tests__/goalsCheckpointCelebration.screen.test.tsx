// WHIT-481 — the in-app confetti wired into the Goals hub. Locks the screen behaviour: no burst
// on first paint (even for a goal already past a rung), a burst when a balance moves past a new
// rung, silence on an identical redraw, the mortgage card untouched, and reduce-motion degrading
// to a plain banner that still clears (no stuck overlay). The REAL balanceGoalView + the real
// celebration hook/diff run; only the data boundary and the router are stubbed.
// WHIT-685: the goal and its balance come from the fake server through the real screen data code
// (useGoalsScreenData); a balance move is a re-seeded server reply and a cache refresh, as in the app.
// Timers stay real (only today's date is pinned), except in the tests that show a burst. Those move
// the balance on a fully fake clock, so the confetti animation never ticks outside act, and the
// "clears itself" tests run the burst's timer out.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { act, screen } from '@testing-library/react-native';
import { installFakeServer } from './support/fakeServer';
import { refreshInAct, renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { pinToday } from './support/clock';
import { seedGoalsHub } from './support/goalsScreen';
import { EMPTY_LOAN_FACTS } from './factory';
import { queryClient } from '../queryClient';
import type { GoalRecord } from '../api';

jest.mock('../motion/ScrollChromeHeader', () => require('./support/scrollChromeHeaderMock').scrollChromeHeaderMockModule());

jest.mock('../auth', () => require('./support/authMock').authMockModule());

const mockOpenGoalBalance = jest.fn();
jest.mock('../context', () => require('./support/goalsScreen').goalsContextMockModule(() => mockOpenGoalBalance));

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn() }),
  useFocusEffect: () => {},
}));

let mockReduceMotion = false;
jest.mock('../motion/useReduceMotion', () => ({ useReduceMotion: () => mockReduceMotion }));

import Goals from '../../app/(tabs)/goals';

const PAY_CYCLE = { length: 14, last_pay_date: '2026-06-06' };
// A grow goal with a two-rung ladder on a synced account, so the reached count is driven purely
// by the account's live balance on the server.
const GOAL: GoalRecord = {
  id: 'g1', name: 'Holiday', icon: 'wallet', direction: 'grow',
  target_amount: 10000, target_date: '2026-08-15', account_id: 'up-spending',
  checkpoints: [{ id: 'a', label: 'A', amount: 2000 }, { id: 'b', label: 'B', amount: 5000 }],
};

const server = installFakeServer();
useTestQueryClient();

function seedBalance(balance: number) {
  seedGoalsHub(server, {
    goals: [GOAL], payCycle: PAY_CYCLE, balances: { 'up-spending': balance },
    loanFacts: EMPTY_LOAN_FACTS, homeLoan: { balance: 596642.43, asOf: '2026-07-04T00:00:00Z' },
  });
}

// The server now reports a new balance and the screen's data refreshes, as a poll would.
async function moveBalance(balance: number) {
  seedBalance(balance);
  await refreshInAct(() => queryClient.invalidateQueries());
}

// Same move, but on a fully fake clock, so the burst's own timer can be run out instead of waited for.
async function moveBalanceOnFakeClock(balance: number) {
  jest.useFakeTimers({ now: new Date(2026, 6, 11) });
  await moveBalance(balance);
}

async function runOutBurst(ms: number) {
  await act(async () => { jest.advanceTimersByTime(ms); });
}

beforeEach(() => {
  resetAuth();
  mockReduceMotion = false;
  pinToday(new Date(2026, 6, 11));
  seedBalance(4000); // past the 2000 rung, not the 5000 rung → reached 1
});
afterEach(() => { jest.useRealTimers(); });

describe('checkpoint celebration on the Goals hub (WHIT-481)', () => {
  it('does not burst on first paint, even for a goal already past a rung', async () => {
    seedBalance(6000); // already past BOTH rungs when the screen opens → reached 2
    await renderWithQueries(<Goals />);
    expect(screen.queryByTestId('checkpoint-celebration')).toBeNull();
  });

  it('bursts once when a balance moves past a new rung', async () => {
    await renderWithQueries(<Goals />);              // seed at reached 1, no burst
    expect(screen.queryByTestId('checkpoint-celebration')).toBeNull();

    await moveBalanceOnFakeClock(6000);               // 4000 → 6000 crosses the 5000 rung (reached 2)
    expect(screen.getByTestId('checkpoint-celebration')).toBeTruthy();
    expect(screen.getByText(/Holiday: checkpoint reached/)).toBeTruthy();
  });

  it('is silent when a refresh brings back identical data', async () => {
    await renderWithQueries(<Goals />);
    await moveBalance(4000);                          // same reply → the cache keeps its data, no burst
    expect(server.sent('GET', '/accounts/balances')).toHaveLength(2);
    expect(screen.queryByTestId('checkpoint-celebration')).toBeNull();
  });

  it('clears itself after the burst so there is no stuck overlay', async () => {
    await renderWithQueries(<Goals />);
    await moveBalanceOnFakeClock(6000);
    expect(screen.getByTestId('checkpoint-celebration')).toBeTruthy();
    await runOutBurst(1200); // FALL_MS
    expect(screen.queryByTestId('checkpoint-celebration')).toBeNull();
  });

  it('keeps the mortgage card untouched whether or not a burst is showing', async () => {
    await renderWithQueries(<Goals />);
    expect(screen.getByTestId('mortgage-link')).toBeTruthy();
    await moveBalanceOnFakeClock(6000);
    expect(screen.getByTestId('checkpoint-celebration')).toBeTruthy();
    expect(screen.getByTestId('mortgage-link')).toBeTruthy(); // still there under the confetti
  });

  it('reduce-motion still shows and clears the banner (no stuck overlay)', async () => {
    mockReduceMotion = true;
    await renderWithQueries(<Goals />);
    await moveBalanceOnFakeClock(6000);
    expect(screen.getByTestId('checkpoint-celebration')).toBeTruthy();
    expect(screen.getByTestId('checkpoint-celebration-label')).toBeTruthy();
    await runOutBurst(900); // REDUCED_MS
    expect(screen.queryByTestId('checkpoint-celebration')).toBeNull();
  });
});
