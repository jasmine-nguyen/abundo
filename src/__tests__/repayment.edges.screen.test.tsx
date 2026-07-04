// WHIT-115 — adversarial GAP screen tests for the Goal-tab last-repayment card.
// milestone.screen.test.tsx already locks the real card (amount+date+split, no
// "9:02am") and the empty-state copy. This file guards the two structural changes
// the implementer's tests don't touch:
//   1. the "Preview a repayment alert" button now lives OUTSIDE the present/empty
//      branch — it must still render AND fire s.fireRepayment in the EMPTY state.
//   2. the card was un-gated from g.factsReady — with loan facts UNSET it must
//      still render (real card when a repayment exists, empty state otherwise),
//      i.e. it no longer disappears during the "set up your loan" hero state.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import type { AppContext } from '../context';

let mockState: AppContext;
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn() }),
}));

import Goals from '../../app/(tabs)/goals';

const GOAL = {
  original: 500000, balance: 432900, homeValue: 640000, startYear: 'Mar 2021',
  ratePct: 5.74, baseRepay: 1240, extra: 200, freedomDate: 'Aug 2045', aheadLabel: '4y 3m', interestSaved: 58200,
  lastRepay: { amount: 1440, principal: 1208, interest: 232, date: 'Today · 9:02am' },
};

const SET_FACTS = { original: 500000, homeValue: 770000, lvr: 0.8, ratePct: 5.74, baseRepay: 1240, extra: 200 };
const UNSET_FACTS = { original: null, homeValue: null, lvr: null, ratePct: null, baseRepay: null, extra: null };
const NO_REPAYMENT = { amount: null, date: null, principal: null, interest: null };

function state(over: Partial<AppContext>): AppContext {
  return {
    homeLoan: { balance: null, asOf: null },
    loanFacts: SET_FACTS,
    repayment: NO_REPAYMENT,
    goal: GOAL,
    category: (_id: string | null) => undefined,
    ...over,
  } as unknown as AppContext;
}

beforeEach(() => { mockPush.mockClear(); });

it('empty state still renders the preview button and pressing it fires fireRepayment', () => {
  const fireRepayment = jest.fn();
  mockState = state({ repayment: NO_REPAYMENT, fireRepayment: fireRepayment as AppContext['fireRepayment'] });
  render(<Goals />);
  // The empty copy AND the shared preview button both show.
  expect(screen.getByText(/No repayment on record yet/)).toBeTruthy();
  fireEvent.press(screen.getByText('Preview a repayment alert'));
  expect(fireRepayment).toHaveBeenCalledTimes(1);
});

it('renders the last-repayment card even when loan facts are UNSET (un-gated from factsReady)', () => {
  mockState = state({
    loanFacts: UNSET_FACTS,
    repayment: { amount: 1440, date: '2026-07-01', principal: 1208, interest: 232 },
    fireRepayment: jest.fn() as AppContext['fireRepayment'],
  });
  render(<Goals />);
  // Hero is in its "set up your loan" state...
  expect(screen.getByText('Set up loan details →')).toBeTruthy();
  // ...and the real repayment card is STILL shown alongside it.
  expect(screen.getByText('$1,208 principal · $232 interest')).toBeTruthy();
  expect(screen.getByText('$1,440')).toBeTruthy();
});

it('shows the empty card (not nothing) when facts are unset and no repayment exists', () => {
  mockState = state({ loanFacts: UNSET_FACTS, repayment: NO_REPAYMENT, fireRepayment: jest.fn() as AppContext['fireRepayment'] });
  render(<Goals />);
  expect(screen.getByText(/No repayment on record yet/)).toBeTruthy();
});
