// WHIT-233 — the Goals hub screen (app/(tabs)/goals). Locks: the empty state, real goal
// cards (progress %, pace, paydays from the actual balanceGoalView engine over injected
// useGoalsScreenData), the always-present mortgage card (balance / mortgageError / tap-through),
// loading + primary-error states, and every navigation target (the "+" and cards route to
// /goal/edit, the mortgage card to /mortgage). ScrollChromeHeader is mocked to a passthrough
// (its clearance/scroll wiring is covered by tabScreens*); the REAL balanceGoalView runs, so a
// selector revert reddens the % / pace assertions. Clock pinned to Sat 11 Jul 2026 so the
// pay-cycle pace is deterministic (matches the balanceGoal.logic fixtures).
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react-native';

// Passthrough header so the hub's content (and its `right` action) render without the
// NavBarsProvider the real ScrollChromeHeader needs.
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

// WHIT-235: the hub now calls useAppContext for openGoalBalance. Keep the real balanceGoalView
// (the % / pace assertions run the real engine); only the writer boundary is stubbed.
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

const PAY_CYCLE = { length: 14, last_pay_date: '2026-06-06' }; // paydays …Jul18, Aug1, Aug15
const GROW = { id: 'g1', name: 'Emergency fund', icon: 'wallet', direction: 'grow', target_amount: 10000, target_date: '2026-08-15', account_id: 'up-spending' };
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
  jest.useFakeTimers({ now: new Date(2026, 6, 11) }); // Sat 11 Jul 2026
  mockData = baseData();
});
afterEach(() => { jest.useRealTimers(); });

describe('empty state', () => {
  it('shows the "no goals yet" prompt, the add button, and the mortgage card', () => {
    render(<Goals />);
    expect(screen.getByTestId('goals-empty')).toBeTruthy();
    expect(screen.getByText('No goals yet')).toBeTruthy();
    expect(screen.getByTestId('add-goal-cta')).toBeTruthy();
    expect(screen.getByTestId('mortgage-link')).toBeTruthy(); // always shown (Option A)
  });
});

describe('goal cards (real balanceGoalView)', () => {
  beforeEach(() => { mockData = baseData({ goals: [GROW, PAYDOWN] }); });

  it('renders a grow goal: 40% there, $2,000/payday, 3 paydays left', () => {
    render(<Goals />);
    expect(screen.getByText('Emergency fund')).toBeTruthy();
    expect(screen.getByText('Saving toward $10,000 · by Aug 2026')).toBeTruthy();
    const card = within(screen.getByTestId('goal-card-g1'));
    expect(card.getByText('40%')).toBeTruthy();
    expect(card.getByText('$2,000 / payday')).toBeTruthy();
    expect(card.getByText('3 paydays left')).toBeTruthy();
  });

  it('renders a paydown goal: 40% paid off, $4,000/payday', () => {
    render(<Goals />);
    const card = within(screen.getByTestId('goal-card-g2'));
    expect(screen.getByText('Paying down $0 · by Aug 2026')).toBeTruthy();
    expect(card.getByText('40%')).toBeTruthy();
    expect(card.getByText('$4,000 / payday')).toBeTruthy();
  });

  it('a synced goal with no live balance yet shows "—" and a waiting label, not a crash', () => {
    mockData = baseData({ goals: [GROW], balanceFor: () => null }); // account not polled
    render(<Goals />);
    const card = within(screen.getByTestId('goal-card-g1'));
    expect(card.getByText('—')).toBeTruthy();
    expect(card.getByText('Waiting on your balance')).toBeTruthy();
  });
});

describe('the mortgage card', () => {
  it('shows the balance owing when the home loan has loaded', () => {
    render(<Goals />);
    expect(within(screen.getByTestId('mortgage-link')).getByText('$596,642 owing')).toBeTruthy();
  });

  it('a SECONDARY mortgage failure still shows the card (tap to open), never blanks the hub', () => {
    mockData = baseData({ homeLoan: { balance: null, asOf: null }, mortgageError: true });
    render(<Goals />);
    expect(within(screen.getByTestId('mortgage-link')).getByText('Tap to open your payoff plan')).toBeTruthy();
    expect(screen.getByTestId('goals-empty')).toBeTruthy(); // hub still renders its goals section
  });
});

describe('loading + error', () => {
  it('shows a spinner while loading with nothing cached', () => {
    mockData = baseData({ isLoading: true });
    render(<Goals />);
    expect(screen.getByTestId('goals-loading')).toBeTruthy();
    expect(screen.queryByTestId('goals-empty')).toBeNull();
  });

  it('shows an error + Retry when a PRIMARY read fails with nothing cached', () => {
    const refetch = jest.fn();
    mockData = baseData({ isError: true, refetch });
    render(<Goals />);
    expect(screen.getByTestId('goals-error')).toBeTruthy();
    fireEvent.press(screen.getByTestId('goals-retry'));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('keeps showing goals when isError but rows are cached (cache-first)', () => {
    mockData = baseData({ goals: [GROW], isError: true });
    render(<Goals />);
    expect(screen.queryByTestId('goals-error')).toBeNull();
    expect(screen.getByTestId('goal-card-g1')).toBeTruthy();
  });
});

describe('navigation', () => {
  beforeEach(() => { mockData = baseData({ goals: [GROW] }); });

  it('the "+" routes to the goal add screen', () => {
    render(<Goals />);
    fireEvent.press(screen.getByTestId('add-goal'));
    expect(mockPush).toHaveBeenCalledWith('/goal/edit');
  });

  it('a goal card routes to the edit screen with its id', () => {
    render(<Goals />);
    fireEvent.press(screen.getByTestId('goal-card-g1'));
    expect(mockPush).toHaveBeenCalledWith('/goal/edit?id=g1');
  });

  it('the mortgage card routes to the full mortgage screen', () => {
    render(<Goals />);
    fireEvent.press(screen.getByTestId('mortgage-link'));
    expect(mockPush).toHaveBeenCalledWith('/mortgage');
  });
});

describe('manual goal balance (WHIT-235)', () => {
  beforeEach(() => { mockData = baseData({ goals: [GROW, PAYDOWN] }); });

  it('a MANUAL goal shows its "as of" date + an Update balance affordance', () => {
    render(<Goals />);
    const card = within(screen.getByTestId('goal-card-g2'));
    expect(card.getByText('Balance as of 1 Jul 2026')).toBeTruthy();
    expect(card.getByTestId('goal-balance-g2')).toBeTruthy();
  });

  it('a SYNCED goal shows neither the "as of" line nor the affordance', () => {
    render(<Goals />);
    const card = within(screen.getByTestId('goal-card-g1'));
    expect(card.queryByTestId('goal-balance-g1')).toBeNull();
    expect(card.queryByText(/Balance as of/)).toBeNull();
  });

  it('tapping Update balance opens the balance sheet for that goal', () => {
    render(<Goals />);
    fireEvent.press(screen.getByTestId('goal-balance-g2'));
    expect(mockOpenGoalBalance).toHaveBeenCalledWith('g2');
    // (The card-body-still-navigates complement is goalsHubBalanceGaps [A17]; RNTL never bubbles
    // an inner press to the parent, so asserting "no push" here would pass tautologically.)
  });

  it('flags a balance not updated in over 30 days as stale', () => {
    mockData = baseData({ goals: [{ ...PAYDOWN, id: 'g3', manual_as_of: '2026-05-01' }] }); // 71 days before
    render(<Goals />);
    expect(within(screen.getByTestId('goal-card-g3')).getByText('Haven’t updated in a while')).toBeTruthy();
  });

  it('does NOT flag a recently-updated balance', () => {
    render(<Goals />); // PAYDOWN as-of 2026-07-01, 10 days before the pinned clock
    expect(within(screen.getByTestId('goal-card-g2')).queryByText('Haven’t updated in a while')).toBeNull();
  });
});
