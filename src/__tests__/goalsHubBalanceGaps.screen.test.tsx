// WHIT-235 — GAP tests for the Goals hub's manual-balance affordance (app/(tabs)/goals). The
// adversarial half of goalsHub.screen.test.tsx: the stale BOUNDARY (30 vs 31 days), a manual goal
// with NO as-of date ("Balance not set", no crash, no stale tag), and the regression that tapping
// the card BODY of a manual goal still routes to edit despite the nested "Update balance" button.
// Same harness as goalsHub.screen.test.tsx: passthrough header, mocked useGoalsScreenData, real
// balanceGoalView, useAppContext stubbed to openGoalBalance, expo-router mocked. Clock pinned to
// Sat 11 Jul 2026 so the day-diff is deterministic under the runner's Australia/Melbourne TZ.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react-native';

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

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
  useFocusEffect: () => {},
}));

import Goals from '../../app/(tabs)/goals';

const PAY_CYCLE = { length: 14, last_pay_date: '2026-06-06' };
const PAYDOWN = { id: 'g2', name: 'Car loan', icon: 'car', direction: 'paydown', target_amount: 0, target_date: '2026-08-15', baseline: 20000, manual_balance: 12000, manual_as_of: '2026-07-01', account_id: null };

function baseData(over: Record<string, unknown> = {}) {
  return {
    goals: [] as unknown[],
    payCycle: PAY_CYCLE,
    balanceFor: (id: string | null | undefined) => (id === 'up-spending' ? 4000 : null),
    loanFacts: { original: null, homeValue: null, lvr: null, ratePct: null, baseRepay: null, extra: null },
    homeLoan: { balance: 596642.43, asOf: '2026-07-04T00:00:00Z' },
    mortgageError: false,
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
    refetchStale: jest.fn(),
    ...over,
  };
}

beforeEach(() => {
  mockPush.mockClear();
  mockOpenGoalBalance.mockClear();
  jest.useFakeTimers({ now: new Date(2026, 6, 11) }); // Sat 11 Jul 2026 local (Australia/Melbourne)
  mockData = baseData();
});
afterEach(() => { jest.useRealTimers(); });

// [A14] the stale threshold is "> 30 days". Exactly 30 days old must NOT flag; 31 days must. The
// implementer only tested 71 days (stale) and 10 days (fresh) — neither pins the boundary, so an
// off-by-one (>= vs >) would pass their suite. 2026-06-11 is 30 days before the pinned clock.
it('does NOT flag a balance exactly 30 days old (boundary, not > 30)', () => {
  mockData = baseData({ goals: [{ ...PAYDOWN, id: 'g30', manual_as_of: '2026-06-11' }] });
  render(<Goals />);
  expect(within(screen.getByTestId('goal-card-g30')).queryByText('Haven’t updated in a while')).toBeNull();
});

// [A15] the matching over-boundary case.
it('flags a balance 31 days old (just over the boundary)', () => {
  mockData = baseData({ goals: [{ ...PAYDOWN, id: 'g31', manual_as_of: '2026-06-10' }] });
  render(<Goals />);
  expect(within(screen.getByTestId('goal-card-g31')).getByText('Haven’t updated in a while')).toBeTruthy();
});

// [A16] a manual goal with NO as-of date shows "Balance not set" (never a crash / blank / "as of
// undefined") and is not flagged stale. balanceIsStale(null) short-circuits to false.
it('a manual goal with a null as-of shows "Balance not set" and no stale tag', () => {
  mockData = baseData({ goals: [{ ...PAYDOWN, id: 'gnull', manual_as_of: null }] });
  render(<Goals />);
  const card = within(screen.getByTestId('goal-card-gnull'));
  expect(card.getByText('Balance not set')).toBeTruthy();
  expect(card.queryByText(/Balance as of/)).toBeNull();
  expect(card.queryByText('Haven’t updated in a while')).toBeNull();
});

// [A17] REGRESSION: adding the nested "Update balance" button inside the card must not steal taps
// on the card body — tapping the card (not the button) still routes to the edit screen, and the
// sheet does NOT open. Mirrors the existing synced-card nav test, but for a MANUAL card.
it('tapping a manual goal card body still routes to edit (not the sheet)', () => {
  mockData = baseData({ goals: [PAYDOWN] });
  render(<Goals />);
  fireEvent.press(screen.getByTestId('goal-card-g2'));
  expect(mockPush).toHaveBeenCalledWith('/goal/edit?id=g2');
  expect(mockOpenGoalBalance).not.toHaveBeenCalled();
});
