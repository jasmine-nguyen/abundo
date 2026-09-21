// WHIT-372 — the Goals-hub mortgage CARD when the balance is ABOVE the original (a redraw/refinance
// that grew the loan). goalsHubRichGaps covers == original [G2] and sub-dollar [G6]; this covers the
// strictly-above case. The card's gate moved from `Math.round(paidDown) > 0` to the shared
// `paidDownReady` — same predicate — so it must STILL fall to the plain "$X owing" line, never an
// incoherent "$1 / 0% gone" rich card. Mirrors goalsHubRichGaps' harness (REAL goalView runs).
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
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ openGoalBalance: jest.fn() }) };
});
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }), useFocusEffect: () => {} }));

import Goals from '../../app/(tabs)/goals';

const READY_FACTS = { original: 500000, homeValue: 900000, lvr: 0.8, ratePct: 5.74, baseRepay: 1240, extra: 200, payoffGoalDate: null };

function baseData(over: Record<string, unknown> = {}) {
  return {
    goals: [] as unknown[],
    payCycle: { length: 14, last_pay_date: '2026-06-06' },
    balanceFor: () => null,
    loanFacts: READY_FACTS,
    homeLoan: { balance: 500001, asOf: '2026-07-04T00:00:00Z' }, // $1 ABOVE original
    mortgageError: false,
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
    refetchStale: jest.fn(),
    ...over,
  };
}

beforeEach(() => { jest.useFakeTimers({ now: new Date(2026, 6, 11) }); mockData = baseData(); });
afterEach(() => { jest.useRealTimers(); });

describe('WHIT-372 mortgage card — balance above the original', () => {
  it('balance above original → plain "$500,001 owing" line, never a rich "$1 / 0% gone" card', () => {
    render(<Goals />);
    const card = within(screen.getByTestId('mortgage-link'));
    expect(card.getByText('$500,001')).toBeTruthy();
    expect(card.queryByText('PAID DOWN SO FAR')).toBeNull();
    expect(card.queryByText('0% gone')).toBeNull();
    expect(card.queryByText('$1')).toBeNull(); // no fmt(-1) leaking as a paid figure
  });
});
