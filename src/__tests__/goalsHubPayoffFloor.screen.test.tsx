// WHIT-391 GAPS (Goals-hub card, rendered) — the reconcile at the CARD, not just the hero. The diffed
// tests cover the selector + the /mortgage hero, but nothing re-renders the Goals-hub card at a sub-0.5%
// paydown, and the card renders the SAME PayoffSummary via mortgage.paidPctLabel/paidPct. Mirrors
// goalsHubRichGaps.screen's harness exactly (REAL goalView; only useGoalsScreenData + useAppContext
// writer + expo-router mocked), so a floor revert reddens here too.
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

describe('WHIT-391 — Goals-hub card at a sub-0.5% paydown', () => {
  // [F9] $1,200 paid of an $800k loan = 0.15% → raw round 0. The card's rich block (testID mortgage-link)
  // must headline "1% gone" next to the "$1,200" figure, never "0% gone". Proves the card floors, not just
  // the hero. Reverting the WHIT-391 floor → "0% gone" and reddens.
  it('[F9] $1,200 paid on $800k → the card reads "$1,200" next to "1% gone", never "0% gone"', () => {
    mockData = baseData({ loanFacts: READY_FACTS, homeLoan: { balance: 798800, asOf: '2026-07-04T00:00:00Z' } });
    render(<Goals />);
    const card = within(screen.getByTestId('mortgage-link'));
    expect(card.getByText('$1,200')).toBeTruthy();
    expect(card.getByText('1% gone')).toBeTruthy();
    expect(card.queryByText('0% gone')).toBeNull();
    expect(card.getByText('$798,800 to go')).toBeTruthy();
  });

  // [F10] The bar on the card fills to the TRUE 0.15%, not the floored 1% — same honest divergence as the
  // hero. Asserts the serialized card tree carries a "0.15%" width while the words read "1% gone".
  it('[F10] the card bar fills to the true 0.15%, not the floored 1%', () => {
    mockData = baseData({ loanFacts: READY_FACTS, homeLoan: { balance: 798800, asOf: '2026-07-04T00:00:00Z' } });
    render(<Goals />);
    const card = within(screen.getByTestId('mortgage-link'));
    expect(card.getByText('1% gone')).toBeTruthy();
    const tree = JSON.stringify(screen.toJSON());
    expect(tree).toContain('0.15%');
    expect(tree).not.toContain('width":"1%');
  });
});
