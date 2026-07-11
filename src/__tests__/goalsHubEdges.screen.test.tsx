// WHIT-233 — Goals hub (app/(tabs)/goals) EDGE coverage the goalsHub suite leaves open.
// Independent of goalsHub.screen.test: same mock scaffold (passthrough ScrollChromeHeader,
// injected useGoalsScreenData, stable router.push) but exercises the card branches the
// happy-path suite doesn't — a paydown with no baseline (progress null but a real pace),
// an overdue goal (paydaysLeft 0 -> "due now" + whole-amount pace), the singular "1 payday",
// the mortgage card's third branch (balance null, no error), an unknown icon (no crash),
// render order, and url-encoding of a goal id in the edit route. The REAL balanceGoalView
// runs, so a selector revert reddens the %/pace/paydays assertions. Clock pinned to
// Sat 11 Jul 2026 (balanceGoalView reads ambient Date, which fake timers control).
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

// WHIT-235: the hub now calls useAppContext for openGoalBalance; stub the writer, keep the real
// balanceGoalView (the %/pace assertions run the real engine).
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
  jest.useFakeTimers({ now: new Date(2026, 6, 11) }); // Sat 11 Jul 2026
  mockData = baseData();
});
afterEach(() => { jest.useRealTimers(); });

describe('goal-card progress edges', () => {
  // [A20] paydown with NO baseline: balanceGoalView.progress is null (no start reference), so
  // the % must degrade to "—" — but the PACE is still known, so the foot shows a real figure,
  // NOT the "Waiting on your balance" copy. Guards the `pct != null ? … : '—'` split.
  it('a paydown goal with no baseline shows "—" for % yet still a real pace', () => {
    const goal = { id: 'nb', name: 'Credit card', icon: 'cash', direction: 'paydown', target_amount: 0, target_date: '2026-08-15', account_id: null, manual_balance: 9000 };
    mockData = baseData({ goals: [goal] });
    render(<Goals />);
    const card = within(screen.getByTestId('goal-card-nb'));
    expect(card.getByText('—')).toBeTruthy();                 // progress null -> dash, not "0%"
    expect(card.getByText('$3,000 / payday')).toBeTruthy();   // 9000 owed / 3 paydays
    expect(card.queryByText('Waiting on your balance')).toBeNull();
  });

  // [A21] target_date already past -> paydaysLeft 0 -> "due now", and the pace collapses to
  // the WHOLE remaining amount (not remaining/0 = Infinity). Guards the `> 0 ? … : 'due now'`
  // arm and the paydaysLeft===0 pace branch together.
  it('an overdue goal shows "due now" and puts the whole remaining amount on one payday', () => {
    const goal = { id: 'od', name: 'Emergency fund', icon: 'wallet', direction: 'grow', target_amount: 10000, target_date: '2026-06-01', account_id: 'up-spending' };
    mockData = baseData({ goals: [goal] });
    render(<Goals />);
    const card = within(screen.getByTestId('goal-card-od'));
    expect(card.getByText('due now')).toBeTruthy();
    expect(card.getByText('40%')).toBeTruthy();               // 4000/10000, unaffected by the date
    expect(card.getByText('$6,000 / payday')).toBeTruthy();   // whole 6000 remaining, not Infinity
  });

  // [A22] exactly one payday left -> singular "1 payday left" (no trailing 's'). Guards the
  // `paydaysLeft === 1 ? '' : 's'` pluralisation the 3-payday happy path can't reach.
  it('pluralises correctly: exactly one payday reads "1 payday left"', () => {
    const goal = { id: 'one', name: 'Emergency fund', icon: 'wallet', direction: 'grow', target_amount: 10000, target_date: '2026-07-20', account_id: 'up-spending' };
    mockData = baseData({ goals: [goal] });
    render(<Goals />);
    expect(within(screen.getByTestId('goal-card-one')).getByText('1 payday left')).toBeTruthy();
  });

  // [A23] an unknown icon name must not crash the card (Icon falls back internally); the card
  // still renders its name + %.
  it('a goal with an unknown icon renders without crashing', () => {
    const goal = { id: 'ic', name: 'Mystery', icon: 'not-a-real-icon', direction: 'grow', target_amount: 10000, target_date: '2026-08-15', account_id: 'up-spending' };
    mockData = baseData({ goals: [goal] });
    render(<Goals />);
    const card = within(screen.getByTestId('goal-card-ic'));
    expect(card.getByText('Mystery')).toBeTruthy();
    expect(card.getByText('40%')).toBeTruthy();
  });

  // [A24] multiple goals render in the order the data supplies them (a stray sort/reverse
  // regression would flip these).
  it('renders multiple goals in data order', () => {
    const a = { id: 'aa', name: 'First', icon: 'wallet', direction: 'grow', target_amount: 10000, target_date: '2026-08-15', account_id: 'up-spending' };
    const b = { id: 'bb', name: 'Second', icon: 'car', direction: 'grow', target_amount: 10000, target_date: '2026-08-15', account_id: 'up-spending' };
    mockData = baseData({ goals: [a, b] });
    render(<Goals />);
    const ids = screen.getAllByTestId(/^goal-card-/).map((n) => n.props.testID);
    expect(ids).toEqual(['goal-card-aa', 'goal-card-bb']);
  });
});

describe('mortgage card — the third (null, no-error) branch', () => {
  // [A25] balance null AND no mortgageError: neither "owing" nor the error copy — the honest
  // "Tap to see your payoff plan" waiting copy. The goalsHub suite covers owing + error only.
  it('shows "Tap to see your payoff plan" when the balance is not loaded and there is no error', () => {
    mockData = baseData({ homeLoan: { balance: null, asOf: null }, mortgageError: false });
    render(<Goals />);
    const card = within(screen.getByTestId('mortgage-link'));
    expect(card.getByText('Tap to see your payoff plan')).toBeTruthy();
    expect(card.queryByText('Tap to open your payoff plan')).toBeNull();
    expect(card.queryByText(/owing/)).toBeNull();
  });
});

describe('navigation — url-encoding of the goal id', () => {
  // [A26] a goal id with reserved characters is percent-encoded into the edit route, so the
  // param round-trips intact. Guards the encodeURIComponent call.
  it('encodes a goal id that needs escaping', () => {
    const goal = { id: 'a b&c', name: 'Weird id', icon: 'wallet', direction: 'grow', target_amount: 10000, target_date: '2026-08-15', account_id: 'up-spending' };
    mockData = baseData({ goals: [goal] });
    render(<Goals />);
    fireEvent.press(screen.getByTestId('goal-card-a b&c'));
    expect(mockPush).toHaveBeenCalledWith('/goal/edit?id=a%20b%26c');
  });
});
