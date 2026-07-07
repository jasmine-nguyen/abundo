// WHIT-121 (expansion) — GAP tests the implementer's suite misses:
//   1. a11y on BOTH new Goal-tab error affordances (#4): accessibilityRole/Label/testID on
//      the two Retry buttons + accessibilityLiveRegion on the two error copies. Nothing
//      else asserts these props, so a revert that drops them is currently invisible.
//   2. hero branch PRECEDENCE (#2): facts UNSET + homeLoanError must show the "set up loan"
//      prompt, NOT the balance error — the `!g.factsReady` branch sits ABOVE the
//      `homeLoanError` branch in goals.tsx. Guards a future re-order that would surface a
//      balance error over a user who hasn't set up their loan (no balance to fail yet from
//      their POV). The existing #2 test only covers facts SET, so it can't catch this.
// Same mock scaffolding as repayment.errorBoundary.screen.test.tsx.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { makeGoalData, EMPTY_LOAN_FACTS, NO_REPAYMENT } from './factory';
import type { GoalScreenData } from '../queries';

let mockGoal: GoalScreenData;
let mockFireRepayment: () => void;
jest.mock('../queries', () => ({ useGoalScreenData: () => mockGoal }));
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ fireRepayment: mockFireRepayment }) };
});

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn() }),
  useFocusEffect: () => {},
}));

import Goals from '../../app/(tabs)/goals';

beforeEach(() => {
  mockPush.mockClear();
  mockFireRepayment = jest.fn();
});

// #4 — the hero balance-error Retry must be a labelled button and its copy a live region.
// Asserting the actual props (not just presence) fails-on-revert if the a11y attributes
// are stripped. facts SET + balance null + homeLoanError so we land on the error hero.
it('WHIT-121 #4: the hero balance-error Retry + copy carry the a11y props', () => {
  mockGoal = makeGoalData({ homeLoan: { balance: null, asOf: null }, homeLoanError: true, isError: true });
  render(<Goals />);

  const retry = screen.getByTestId('hero-balance-retry');
  expect(retry.props.accessibilityRole).toBe('button');
  expect(retry.props.accessibilityLabel).toBe('Retry loading your balance');

  expect(screen.getByText("Couldn't load your balance.").props.accessibilityLiveRegion).toBe('polite');
});

// #4 — same for the repayment card's error affordance. all-null + repaymentError so we land
// on the repayment error branch (not the real card, not the empty state).
it('WHIT-121 #4: the repayment-error Retry + copy carry the a11y props', () => {
  mockGoal = makeGoalData({ repayment: NO_REPAYMENT, repaymentError: true });
  render(<Goals />);

  const retry = screen.getByTestId('repayment-retry');
  expect(retry.props.accessibilityRole).toBe('button');
  expect(retry.props.accessibilityLabel).toBe('Retry loading your last repayment');

  expect(screen.getByText("Couldn't load your last repayment.").props.accessibilityLiveRegion).toBe('polite');
});

// #2 precedence — facts UNSET wins over a balance error: the hero shows the set-up CTA, and
// the "Couldn't load your balance." error is NOT shown (there is no loan to have a balance
// for yet, from the user's POV). Re-ordering the goals.tsx hero branches so `homeLoanError`
// precedes `!g.factsReady` turns this red. Pairs with the facts-SET #2 test that locks the
// other side of the fork.
it('WHIT-121 #2: with facts UNSET, a balance error yields the set-up prompt, not the error', () => {
  mockGoal = makeGoalData({
    loanFacts: EMPTY_LOAN_FACTS,
    homeLoan: { balance: null, asOf: null },
    homeLoanError: true,
    isError: true,
  });
  render(<Goals />);

  expect(screen.getByText('Set up loan details →')).toBeTruthy();
  expect(screen.queryByText("Couldn't load your balance.")).toBeNull();
  expect(screen.queryByTestId('hero-balance-retry')).toBeNull();
});
