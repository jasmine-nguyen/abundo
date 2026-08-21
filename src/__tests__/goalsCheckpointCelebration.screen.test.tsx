// WHIT-481 — the in-app confetti wired into the Goals hub. Locks the screen behaviour: no burst
// on first paint (even for a goal already past a rung), a burst when a balance moves past a new
// rung, silence on an identical redraw, the mortgage card untouched, and reduce-motion degrading
// to a plain banner that still clears (no stuck overlay). The REAL balanceGoalView + the real
// celebration hook/diff run; only the data boundary and the router are stubbed.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { render, screen, act } from '@testing-library/react-native';

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

let mockReduceMotion = false;
jest.mock('../motion/useReduceMotion', () => ({ useReduceMotion: () => mockReduceMotion }));

import Goals from '../../app/(tabs)/goals';

const PAY_CYCLE = { length: 14, last_pay_date: '2026-06-06' };
// A grow goal with a two-rung ladder on a synced account, so the reached count is driven purely
// by the balanceFor stub below.
const GOAL = {
  id: 'g1', name: 'Holiday', icon: 'wallet', direction: 'grow',
  target_amount: 10000, target_date: '2026-08-15', account_id: 'up-spending',
  checkpoints: [{ amount: 2000 }, { amount: 5000 }],
};
const READY_FACTS = { original: null, homeValue: null, lvr: null, ratePct: null, baseRepay: null, extra: null };

function baseData(balance: number) {
  return {
    goals: [GOAL] as unknown[],
    payCycle: PAY_CYCLE,
    balanceFor: (id: string | null | undefined) => (id === 'up-spending' ? balance : null),
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
  mockReduceMotion = false;
  jest.useFakeTimers({ now: new Date(2026, 6, 11) });
  mockData = baseData(4000); // past the 2000 rung, not the 5000 rung → reached 1
});
afterEach(() => { jest.useRealTimers(); });

describe('checkpoint celebration on the Goals hub (WHIT-481)', () => {
  it('does not burst on first paint, even for a goal already past a rung', () => {
    mockData = baseData(6000); // already past BOTH rungs when the screen opens → reached 2
    render(<Goals />);
    expect(screen.queryByTestId('checkpoint-celebration')).toBeNull();
  });

  it('bursts once when a balance moves past a new rung', () => {
    const { rerender } = render(<Goals />);          // seed at reached 1, no burst
    expect(screen.queryByTestId('checkpoint-celebration')).toBeNull();

    mockData = baseData(6000);                        // 4000 → 6000 crosses the 5000 rung (reached 2)
    rerender(<Goals />);
    expect(screen.getByTestId('checkpoint-celebration')).toBeTruthy();
    expect(screen.getByText(/Holiday: checkpoint reached/)).toBeTruthy();
  });

  it('is silent on an identical redraw (same data reference)', () => {
    const { rerender } = render(<Goals />);
    rerender(<Goals />);                              // same mockData identity → memo stable, no burst
    expect(screen.queryByTestId('checkpoint-celebration')).toBeNull();
  });

  it('clears itself after the burst so there is no stuck overlay', () => {
    const { rerender } = render(<Goals />);
    mockData = baseData(6000);
    rerender(<Goals />);
    expect(screen.getByTestId('checkpoint-celebration')).toBeTruthy();
    act(() => { jest.advanceTimersByTime(1200); });                  // FALL_MS
    expect(screen.queryByTestId('checkpoint-celebration')).toBeNull();
  });

  it('keeps the mortgage card untouched whether or not a burst is showing', () => {
    const { rerender } = render(<Goals />);
    expect(screen.getByTestId('mortgage-link')).toBeTruthy();
    mockData = baseData(6000);
    rerender(<Goals />);
    expect(screen.getByTestId('mortgage-link')).toBeTruthy(); // still there under the confetti
  });

  it('reduce-motion still shows and clears the banner (no stuck overlay)', () => {
    mockReduceMotion = true;
    const { rerender } = render(<Goals />);
    mockData = baseData(6000);
    rerender(<Goals />);
    expect(screen.getByTestId('checkpoint-celebration')).toBeTruthy();
    expect(screen.getByTestId('checkpoint-celebration-label')).toBeTruthy();
    act(() => { jest.advanceTimersByTime(900); });                   // REDUCED_MS
    expect(screen.queryByTestId('checkpoint-celebration')).toBeNull();
  });
});
