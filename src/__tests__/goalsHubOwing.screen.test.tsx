// WHIT-487 — the Goals-hub mortgage card's PLAIN branch, restyled to LEAD with a big bold owing
// amount (30/'800') instead of a 13px subtitle. GAP coverage the goalsHub / Overpaid / Edges suites
// leave open. Independent harness (passthrough header, injected useGoalsScreenData, stubbed writer,
// stable router.push) matching the sibling files; REAL goalView runs so the branch gate is genuine.
// Clock pinned to Sat 11 Jul 2026 for parity with the other goals-hub suites (the pace math is
// deterministic; the mortgage card itself is date-independent).
//
// Covers: [O1] the "owing" suffix is its OWN styled node inside the amount line;
// [O2] no-balance fallback renders the sentence at the FALLBACK style, not the headline, and the
//      big-number testID is ABSENT; [O3] the error fallback likewise absent-testID;
// [O4] tap-through to /mortgage still fires from the restacked NO-balance card;
// [O5] the RICH branch renders its own figure and NO mortgage-owing testID;
// [O6] a $0 balance still renders mortgage-owing ("$0 owing" — 0 is not null).
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
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ openGoalBalance: jest.fn() }) };
});
const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }), useFocusEffect: () => {} }));

import Goals from '../../app/(tabs)/goals';

const PAY_CYCLE = { length: 14, last_pay_date: '2026-06-06' };
// A fully-populated LoanFacts so loanFactsReady is true and the card takes the RICH branch (original
// well above the balance, so there's a genuine paydown to headline).
const READY_FACTS = { original: 800000, homeValue: 900000, lvr: 0.8, ratePct: 5.74, baseRepay: 1240, extra: 200, payoffGoalDate: null };

function baseData(over: Record<string, unknown> = {}) {
  return {
    goals: [] as unknown[],
    payCycle: PAY_CYCLE,
    balanceFor: () => null,
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
  jest.useFakeTimers({ now: new Date(2026, 6, 11) });
  mockData = baseData();
});
afterEach(() => { jest.useRealTimers(); });

describe('WHIT-487 plain mortgage card — owing headline gaps', () => {
  // [O1] the "owing" suffix must render as its OWN <Text> node (its own smaller/lighter style),
  // nested INSIDE the big-number line — not folded into the 30px headline nor a stray sibling.
  // getByText('owing') resolves the inner node exactly (the outer is "$596,642 owing"); `within`
  // the headline proves it's part of the same amount line. Reverting to a single "$X owing" string
  // (the old mortgageSub) removes the standalone node → getByText('owing') throws.
  it('[O1] renders "owing" as its own 14/700 node inside the amount line', () => {
    render(<Goals />);
    const headline = screen.getByTestId('mortgage-owing');
    const suffix = within(headline).getByText('owing'); // descendant of the headline line
    expect(suffix).toBeTruthy();
    expect(suffix).toHaveStyle({ fontSize: 14, fontWeight: '700' });
    // and the suffix is NOT the big headline itself (its style differs from the 30px number)
    expect(suffix).not.toHaveStyle({ fontSize: 30 });
  });

  // [O2] NO balance, no error: the sentence renders at the FALLBACK style (14/'600'), and the big
  // headline number is ABSENT — the two branches are exclusive. Edges [A25] locks the copy/`/owing/`
  // null but NOT the testID absence nor the fallback style; this is the missing lock.
  it('[O2] no-balance fallback renders at the fallback style and NOT the big-number testID', () => {
    mockData = baseData({ homeLoan: { balance: null, asOf: null }, mortgageError: false });
    render(<Goals />);
    const card = within(screen.getByTestId('mortgage-link'));
    expect(card.queryByTestId('mortgage-owing')).toBeNull();     // the loud number must be absent
    const line = card.getByText('Tap to see your payoff plan');
    expect(line).toHaveStyle({ fontSize: 14, fontWeight: '600' }); // fallback, not the 30px headline
    expect(line).not.toHaveStyle({ fontSize: 30 });
  });

  // [O3] error fallback: same absence guard for the error copy path.
  it('[O3] error fallback shows the "open" copy with no mortgage-owing headline', () => {
    mockData = baseData({ homeLoan: { balance: null, asOf: null }, mortgageError: true });
    render(<Goals />);
    const card = within(screen.getByTestId('mortgage-link'));
    expect(card.queryByTestId('mortgage-owing')).toBeNull();
    expect(card.getByText('Tap to open your payoff plan')).toHaveStyle({ fontSize: 14, fontWeight: '600' });
  });

  // [O4] the restacked NO-balance card still routes into /mortgage on tap (the existing nav test
  // only presses the balance-present card; the fallback arm is a different subtree).
  it('[O4] tapping the no-balance fallback card still routes to /mortgage', () => {
    mockData = baseData({ homeLoan: { balance: null, asOf: null }, mortgageError: false });
    render(<Goals />);
    fireEvent.press(screen.getByTestId('mortgage-link'));
    expect(mockPush).toHaveBeenCalledWith('/mortgage');
  });

  // [O5] the RICH branch must NOT also render the plain headline testID — only one branch owns the
  // number. The rich suite asserts `/owing/` is null but never the testID, so a stray plain node
  // leaking alongside the rich body would slip through.
  it('[O5] the rich payoff branch renders its own figure and NO mortgage-owing testID', () => {
    mockData = baseData({ loanFacts: READY_FACTS }); // original 800k, balance 596,642 → rich
    render(<Goals />);
    const card = within(screen.getByTestId('mortgage-link'));
    expect(card.getByText('PAID DOWN SO FAR')).toBeTruthy(); // rich body present
    expect(card.queryByTestId('mortgage-owing')).toBeNull();  // plain headline NOT also rendered
  });

  // [O6] a $0 balance is a real, loaded number (0 != null) → the plain headline still renders
  // "$0 owing". Guards the `balance != null` gate against a truthiness slip (`balance ? …`) that
  // would drop a genuinely-zero balance into the fallback copy. No rich facts here, so it stays plain.
  it('[O6] a $0 balance renders "$0 owing" as the headline (0 is not null)', () => {
    mockData = baseData({ homeLoan: { balance: 0, asOf: '2026-07-04T00:00:00Z' } });
    render(<Goals />);
    const headline = screen.getByTestId('mortgage-owing');
    expect(headline).toHaveTextContent('$0 owing');
    expect(headline).toHaveStyle({ fontSize: 30, fontWeight: '800' });
    expect(within(screen.getByTestId('mortgage-link')).queryByText('Tap to see your payoff plan')).toBeNull();
  });
});
