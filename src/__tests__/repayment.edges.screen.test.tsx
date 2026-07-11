// WHIT-115 — adversarial GAP screen tests for the mortgage-screen last-repayment card.
// milestone.screen.test.tsx already locks the real card (amount+date+split, no
// "9:02am") and the empty-state copy. This file guards the two structural changes
// the implementer's tests don't touch:
//   1. the "Preview a repayment alert" button now lives OUTSIDE the present/empty
//      branch — it must still render AND fire s.fireRepayment in the EMPTY state.
//   2. the card was un-gated from g.factsReady — with loan facts UNSET it must
//      still render (real card when a repayment exists, empty state otherwise),
//      i.e. it no longer disappears during the "set up your loan" hero state.
// WHIT-197: the loanFacts/homeLoan/repayment now come from useGoalScreenData() (mocked);
// fireRepayment stays on the store, so useAppContext is still mocked for it.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
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

import Mortgage from '../../app/mortgage';

beforeEach(() => {
  mockPush.mockClear();
  mockFireRepayment = jest.fn();
});

it('empty state still renders the preview button and pressing it fires fireRepayment', () => {
  const fireRepayment = jest.fn();
  mockFireRepayment = fireRepayment;
  mockGoal = makeGoalData({ repayment: NO_REPAYMENT });
  render(<Mortgage />);
  // The empty copy AND the shared preview button both show.
  expect(screen.getByText(/No repayment on record yet/)).toBeTruthy();
  fireEvent.press(screen.getByText('Preview a repayment alert'));
  expect(fireRepayment).toHaveBeenCalledTimes(1);
});

it('renders the last-repayment card even when loan facts are UNSET (un-gated from factsReady)', () => {
  mockGoal = makeGoalData({
    loanFacts: EMPTY_LOAN_FACTS,
    repayment: { amount: 1440, date: '2026-07-01', principal: 1208, interest: 232 },
  });
  render(<Mortgage />);
  // Hero is in its "set up your loan" state...
  expect(screen.getByText('Set up loan details →')).toBeTruthy();
  // ...and the real repayment card is STILL shown alongside it.
  expect(screen.getByText('$1,208 principal · $232 interest')).toBeTruthy();
  expect(screen.getByText('$1,440')).toBeTruthy();
});

it('shows the empty card (not nothing) when facts are unset and no repayment exists', () => {
  mockGoal = makeGoalData({ loanFacts: EMPTY_LOAN_FACTS, repayment: NO_REPAYMENT });
  render(<Mortgage />);
  expect(screen.getByText(/No repayment on record yet/)).toBeTruthy();
  // WHIT-121 precedence guard: no error flag → the empty state, NOT the error copy.
  expect(screen.queryByText("Couldn't load your last repayment.")).toBeNull();
});

// WHIT-121 — the failed-fetch error state. A repayment read that fails leaves repayment at
// NO_REPAYMENT; without the error branch the card would show "No repayment on record yet"
// and falsely tell a user with a repayment they have none. The error+Retry replaces it.
it('shows an error + Retry (not the empty state) when the repayment fetch failed', () => {
  const refetch = jest.fn();
  mockGoal = makeGoalData({ repayment: NO_REPAYMENT, repaymentError: true, refetch });
  render(<Mortgage />);
  // The error copy shows; the "no repayment" empty copy must NOT (it would be a lie).
  expect(screen.getByText("Couldn't load your last repayment.")).toBeTruthy();
  expect(screen.queryByText(/No repayment on record yet/)).toBeNull();
  // Retry fires the refetch, and the shared preview button still renders.
  fireEvent.press(screen.getByText('Retry'));
  expect(refetch).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Preview a repayment alert')).toBeTruthy();
});

// Cache-first: a cached repayment must survive a background-refetch failure. Even with
// repaymentError set, a present repayment renders the REAL card (data-first precedence),
// never the error state — the honest thing is to show the last-good value.
it('keeps showing the real repayment card when a refetch fails over cached data', () => {
  // EMPTY_LOAN_FACTS so the contribution card (which would also print "$1,440" for the
  // default facts) doesn't collide with the repayment amount assertion below.
  mockGoal = makeGoalData({
    loanFacts: EMPTY_LOAN_FACTS,
    repayment: { amount: 1440, date: '2026-07-01', principal: 1208, interest: 232 },
    repaymentError: true,
  });
  render(<Mortgage />);
  expect(screen.getByText('$1,440')).toBeTruthy();
  expect(screen.getByText('$1,208 principal · $232 interest')).toBeTruthy();
  expect(screen.queryByText("Couldn't load your last repayment.")).toBeNull();
});
