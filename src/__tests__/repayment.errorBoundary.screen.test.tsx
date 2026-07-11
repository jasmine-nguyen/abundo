// WHIT-121 — GAP tests for the mortgage-screen last-repayment error branch. The implementer's
// repayment.edges.screen.test.tsx locks the error state / precedence / cache-first cases
// with the FULLY-null NO_REPAYMENT and a FULLY-present repayment. These add the gaps:
//   1. a MALFORMED payload (amount xor date) on a SUCCESSFUL fetch (repaymentError:false) →
//      the error branch wins over the empty state via lr.malformed, because the server sent
//      half a repayment we can't render (#3). Two sides of the boundary.
//   2. simultaneous homeLoanError + repaymentError → the hero shows its OWN balance error (#2)
//      and the repayment card shows its OWN repayment error, independently (guards a
//      `repaymentError && !homeLoanError` regression the implementer's homeLoanError:false
//      fixture can't catch, and that the two errors don't clobber each other).
// Same mock scaffolding as repayment.edges.screen.test.tsx.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { makeGoalData, EMPTY_LOAN_FACTS } from './factory';
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

import Mortgage from '../../app/mortgage';

beforeEach(() => {
  mockPush.mockClear();
  mockFireRepayment = jest.fn();
});

// WHIT-121 #3 — a SUCCESSFUL fetch (repaymentError:false) that returns a partial payload
// (amount but null DATE) is malformed: lastRepaymentView reports present:false + malformed,
// and the card must show the error branch — NOT the "No repayment" empty lie for data that
// actually exists, and NOT a half-rendered real card. EMPTY_LOAN_FACTS so the contribution
// card can't print "$1,440". Pins the `|| lr.malformed` render clause (fail-on-revert).
it('shows the error branch for a malformed amount-only payload even with NO error flag', () => {
  mockGoal = makeGoalData({
    loanFacts: EMPTY_LOAN_FACTS,
    repayment: { amount: 1440, date: null, principal: null, interest: null },
    repaymentError: false,
  });
  render(<Mortgage />);
  expect(screen.getByText("Couldn't load your last repayment.")).toBeTruthy();
  expect(screen.queryByText(/No repayment on record yet/)).toBeNull();
  expect(screen.queryByText('$1,440')).toBeNull(); // the real card never half-rendered
  expect(screen.getByTestId('repayment-retry')).toBeTruthy();
});

// The other side of the malformed boundary: a DATE but a null AMOUNT, successful fetch → error wins.
it('shows the error branch for a malformed date-only payload even with NO error flag', () => {
  mockGoal = makeGoalData({
    loanFacts: EMPTY_LOAN_FACTS,
    repayment: { amount: null, date: '2026-07-01', principal: null, interest: null },
    repaymentError: false,
  });
  render(<Mortgage />);
  expect(screen.getByText("Couldn't load your last repayment.")).toBeTruthy();
  expect(screen.queryByText(/No repayment on record yet/)).toBeNull();
});

// Simultaneous failures: with BOTH the balance and the repayment reads failing, the hero
// shows its OWN balance error (WHIT-121 #2) and the repayment card shows its OWN repayment
// error — two independent affordances, each keyed on its own flag. Guards a
// `repaymentError && !homeLoanError` regression the implementer's homeLoanError:false-only
// error fixture can't catch, and that the two error states don't clobber each other. The two
// Retry buttons are addressed by testID (WHIT-121 #4) since "Retry" is now ambiguous.
it('shows the balance error and the repayment error independently when BOTH reads failed', () => {
  const refetch = jest.fn();
  mockGoal = makeGoalData({
    homeLoan: { balance: null, asOf: null },
    repayment: { amount: null, date: null, principal: null, interest: null },
    repaymentError: true,
    homeLoanError: true,
    refetch,
  });
  render(<Mortgage />);
  // Both errors surface, each in its own card.
  expect(screen.getByText("Couldn't load your balance.")).toBeTruthy();
  expect(screen.getByText("Couldn't load your last repayment.")).toBeTruthy();
  expect(screen.queryByText(/No repayment on record yet/)).toBeNull();
  // The repayment card's OWN Retry (not the hero's) fires the refetch.
  fireEvent.press(screen.getByTestId('repayment-retry'));
  expect(refetch).toHaveBeenCalledTimes(1);
});
