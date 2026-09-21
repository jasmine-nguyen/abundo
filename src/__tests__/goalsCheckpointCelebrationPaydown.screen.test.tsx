// WHIT-481 — the Goals-hub confetti for the cases the first screen suite skips. That suite is
// grow-ONLY and always reuses the same mockData object; these add: (1) a PAYDOWN goal on a synced
// account, whose debt FALLING past a rung must burst — proving balanceGoalView's paydown reached
// count (current <= amount) drives the confetti the same way growth does; and (2) a plain redraw
// where the goals array is a BRAND-NEW identity but the reached count is unchanged — the memo
// recomputes a fresh checkpointCounts array, the hook effect re-runs, and it must STILL stay silent.
// The real balanceGoalView + hook + diff run end to end; only the data boundary and router are stubs.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { render, screen } from '@testing-library/react-native';

jest.mock('../motion/ScrollChromeHeader', () => {
  const { View, Text } = require('react-native');
  return {
    ScrollChromeHeader: ({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) => (
      <View><Text>{title}</Text>{right}{children}</View>
    ),
  };
});

let mockData: ReturnType<typeof baseData>;
jest.mock('../queries', () => ({ useGoalsScreenData: () => mockData }));

const mockOpenGoalBalance = jest.fn();
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ openGoalBalance: mockOpenGoalBalance }) };
});

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn() }),
  useFocusEffect: () => {},
}));

jest.mock('../motion/useReduceMotion', () => ({ useReduceMotion: () => false }));

import Goals from '../../app/(tabs)/goals';

const PAY_CYCLE = { length: 14, last_pay_date: '2026-06-06' };
// A PAYDOWN goal on a synced account. Its checkpoints are amounts-owed rungs: reached when the
// owed balance is AT/BELOW the rung. The synced balance is signed (a debt is negative), so paying
// it down toward zero makes the normalised owed amount fall and cross rungs downward.
const DEBT_GOAL = {
  id: 'd1', name: 'Car loan', icon: 'car', direction: 'paydown',
  target_amount: 0, target_date: '2026-12-15', account_id: 'up-loan',
  checkpoints: [{ amount: 8000 }, { amount: 5000 }],
};
const READY_FACTS = { original: null, homeValue: null, lvr: null, ratePct: null, baseRepay: null, extra: null };

// `owed` is the positive dollars still owing; the synced feed reports it as a negative balance.
function baseData(owed: number) {
  return {
    goals: [DEBT_GOAL] as unknown[],
    payCycle: PAY_CYCLE,
    balanceFor: (id: string | null | undefined) => (id === 'up-loan' ? -owed : null),
    loanFacts: READY_FACTS,
    homeLoan: { balance: 596642.43, asOf: '2026-07-04T00:00:00Z' },
    mortgageError: false,
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
    refetchStale: jest.fn(),
  };
}

beforeEach(() => {
  jest.useFakeTimers({ now: new Date(2026, 6, 11) });
  mockData = baseData(6000); // owe 6000: at/below 8000 rung, above 5000 rung → reached 1
});
afterEach(() => { jest.useRealTimers(); });

describe('checkpoint celebration for a paydown goal + array-identity churn (WHIT-481)', () => {
  it('bursts when a paydown balance falls past a new rung', () => {
    // [A-P1] owe 6000 (reached 1) → owe 4000 crosses the 5000 rung (reached 2) → one burst.
    const { rerender } = render(<Goals />);              // seed at reached 1, no burst
    expect(screen.queryByTestId('checkpoint-celebration')).toBeNull();

    mockData = baseData(4000);                            // debt shrinks past the 5000 rung
    rerender(<Goals />);
    expect(screen.getByTestId('checkpoint-celebration')).toBeTruthy();
    expect(screen.getByText(/Car loan: checkpoint reached/)).toBeTruthy();
  });

  it('does NOT burst when the debt rises back above a rung (re-arm, not celebrate)', () => {
    // [A-P2] a paydown balance going the WRONG way (owed increases, reached drops) must be silent.
    const { rerender } = render(<Goals />);              // owe 6000 → reached 1
    mockData = baseData(9000);                            // owe more: now above the 8000 rung → reached 0
    rerender(<Goals />);
    expect(screen.queryByTestId('checkpoint-celebration')).toBeNull();
  });

  it('does not burst on a plain redraw even when the goals array is a new identity', () => {
    // [A-P3] fresh mockData object (new goals array + new balanceFor) but the SAME owed amount:
    // the memo yields a new checkpointCounts identity and the effect re-runs, yet reached is
    // unchanged → no burst. The identical-reference test can't reach this path.
    const { rerender } = render(<Goals />);              // owe 6000 → reached 1, seeded
    mockData = baseData(6000);                            // brand-new object, identical owed amount
    rerender(<Goals />);
    expect(screen.queryByTestId('checkpoint-celebration')).toBeNull();
  });
});
