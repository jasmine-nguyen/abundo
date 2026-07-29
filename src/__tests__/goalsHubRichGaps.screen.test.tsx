// WHIT-296 GAPS — the Goals-hub mortgage rich-payoff card (testID `mortgage-link`), adversarial
// boundaries the implementer's `describe('the mortgage card — rich payoff state')` leaves open.
// Mirrors goalsHub.screen.test.tsx's harness exactly: REAL goalView runs (only useGoalsScreenData,
// useAppContext writer + expo-router are mocked), so every payoff number is computed for real and a
// selector/prod revert reddens these. Clock pinned to Sat 11 Jul 2026 for determinism (unused by the
// payoff math, kept to match the sibling suite's env). Covers:
//   [G2] balance == original — the exact-equality boundary: paidOff is naturally 0, so there's no
//        genuine progress and the card shows the plain "owing" line, not an empty rich card
//   [G3] paidPct rounds UP — proves Math.round, not floor/trunc, on "% gone"
//   [G4] rich mortgage + real goals — ordering: the mortgage still leads the list
//   [G5] rich mortgage + empty list — the additive empty-hint still coexists
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { render, screen, within } from '@testing-library/react-native';

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
const GROW = { id: 'g1', name: 'Emergency fund', icon: 'wallet', direction: 'grow', target_amount: 10000, target_date: '2026-08-15', account_id: 'up-spending' };
// A fully-populated LoanFacts so loanFactsReady() is true → the card takes its rich branch.
const READY_FACTS = { original: 800000, homeValue: 900000, lvr: 0.8, ratePct: 5.74, baseRepay: 1240, extra: 200, payoffGoalDate: null };

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
  jest.useFakeTimers({ now: new Date(2026, 6, 11) });
  mockData = baseData();
});
afterEach(() => { jest.useRealTimers(); });

describe('WHIT-296 rich mortgage card — gap boundaries', () => {
  // [G2] balance EXACTLY equal to the original: the natural zero boundary — paidOff is genuinely 0,
  // so there's no honest paydown to headline. The card must fall through to the plain "owing" line,
  // not show an empty "$0 / 0% gone" rich card. This is the exact edge of the `paidDown > 0` gate.
  it('[G2] balance exactly equal to original → the plain "owing" line, not an empty rich card', () => {
    mockData = baseData({ loanFacts: { ...READY_FACTS, original: 596642.43 } }); // == default balance
    render(<Goals />);
    const card = within(screen.getByTestId('mortgage-link'));
    expect(card.getByText('$596,642 owing')).toBeTruthy();
    expect(card.queryByText('PAID DOWN SO FAR')).toBeNull();
  });

  // [G3] "% gone" must ROUND, not floor/truncate. 205,000 / 800,000 = 25.625% → 26%. A floor or
  // trunc would render "25% gone", so this reddens if Math.round is swapped for Math.floor.
  it('[G3] paidPct that lands on x.625 rounds UP to the next whole percent', () => {
    mockData = baseData({ loanFacts: READY_FACTS, homeLoan: { balance: 595000, asOf: '2026-07-04T00:00:00Z' } });
    render(<Goals />);
    const card = within(screen.getByTestId('mortgage-link'));
    expect(card.getByText('$205,000')).toBeTruthy();       // 800,000 − 595,000
    expect(card.getByText('26% gone')).toBeTruthy();        // 25.625 → 26 (round, not 25)
    expect(card.getByText('$595,000 to go')).toBeTruthy();
  });

  // [G4] with real goals present the rich mortgage must still LEAD the list (it's the headline
  // goal). Compare serialized render order — React renders children in array order, so the
  // mortgage-link testID must appear before goal-card-g1's.
  it('[G4] the rich mortgage card renders BEFORE the real goal cards', () => {
    mockData = baseData({ loanFacts: READY_FACTS, goals: [GROW] });
    render(<Goals />);
    // both present
    expect(within(screen.getByTestId('mortgage-link')).getByText('PAID DOWN SO FAR')).toBeTruthy();
    expect(screen.getByTestId('goal-card-g1')).toBeTruthy();
    // ordering
    const tree = JSON.stringify(screen.toJSON());
    expect(tree.indexOf('"mortgage-link"')).toBeGreaterThanOrEqual(0);
    expect(tree.indexOf('"mortgage-link"')).toBeLessThan(tree.indexOf('"goal-card-g1"'));
  });

  // [G5] rich mortgage + an EMPTY goals list: the additive invite (goals-empty-hint) must still
  // coexist — entering the rich state must not suppress it or resurrect "No goals yet".
  it('[G5] rich mortgage coexists with the empty-list invite (never "No goals yet")', () => {
    mockData = baseData({ loanFacts: READY_FACTS, goals: [] });
    render(<Goals />);
    expect(within(screen.getByTestId('mortgage-link')).getByText('PAID DOWN SO FAR')).toBeTruthy();
    expect(screen.getByTestId('goals-empty-hint')).toBeTruthy();
    expect(screen.queryByText('No goals yet')).toBeNull();
  });

  // [G6] a SUB-DOLLAR paydown must NOT headline the rich card: paidOff = 0.30 would pass a raw
  // `paidDown > 0` gate, but fmt(0.30) rounds to "$0" → the "$0 paid down" nonsense. The gate
  // rounds to whole dollars (like fmt), so a 30c paydown stays on the plain "owing" line.
  it('[G6] a 30c paydown shows the plain owing line, not a "$0 paid down" rich card', () => {
    mockData = baseData({ loanFacts: READY_FACTS, homeLoan: { balance: 799999.70, asOf: '2026-07-04T00:00:00Z' } });
    render(<Goals />);
    const card = within(screen.getByTestId('mortgage-link'));
    expect(card.queryByText('PAID DOWN SO FAR')).toBeNull();
    expect(card.getByText('$800,000 owing')).toBeTruthy();
  });

  // [G7] a residual-cents balance that DISPLAYS as "$0 to go" must read "100% gone", not 99 — the
  // 100% branch keys off the rounded balance so the label agrees with the "$0 to go" figure.
  it('[G7] a 43c residual balance ("$0 to go") reads 100% gone, not 99%', () => {
    mockData = baseData({ loanFacts: READY_FACTS, homeLoan: { balance: 0.43, asOf: '2026-07-04T00:00:00Z' } });
    render(<Goals />);
    const card = within(screen.getByTestId('mortgage-link'));
    expect(card.getByText('$0 to go')).toBeTruthy();
    expect(card.getByText('100% gone')).toBeTruthy();
  });
});
