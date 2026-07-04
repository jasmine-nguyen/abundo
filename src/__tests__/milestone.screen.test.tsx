// Screen tests for the Home Loan Milestone screen (WHIT-8) and its entry point.
// Context is injected via jest.mock so the real milestoneView / goalView selectors
// run over mocked state; expo-router's useRouter is mocked to capture navigation.
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

import Milestone from '../../app/milestone';
import Goals from '../../app/(tabs)/goals';

function state(over: Partial<AppContext>): AppContext {
  return {
    homeLoan: { balance: null, asOf: null },
    category: (id: string | null) => undefined,
    ...over,
  } as unknown as AppContext;
}

beforeEach(() => {
  mockPush.mockClear();
});

// --- the milestone screen ----------------------------------------------------

it('renders the live balance, the sprint plan, and usable equity', () => {
  mockState = state({ homeLoan: { balance: 596642.43, asOf: '2026-07-04T00:24:37.614Z' } });
  render(<Milestone />);
  expect(screen.getByText('$596,642')).toBeTruthy();       // hero balance
  expect(screen.getByText('The 36-month plan')).toBeTruthy();
  expect(screen.getByText('Investment property #2')).toBeTruthy();
  // Sprint 0 is the next milestone at this balance, so its callout shows.
  expect(screen.getByText('under $544,000')).toBeTruthy();
});

it('shows a waiting state before the live balance has loaded', () => {
  mockState = state({ homeLoan: { balance: null, asOf: null } });
  render(<Milestone />);
  expect(screen.getByText('Fetching your live balance…')).toBeTruthy();
  // No fabricated balance while unknown.
  expect(screen.queryByText(/milestones reached/)).toBeNull();
});

it('shows an error + retry (not a permanent spinner) when the fetch failed', () => {
  const refreshHomeLoan = jest.fn();
  mockState = state({ homeLoan: { balance: null, asOf: null }, homeLoanError: true, refreshHomeLoan: refreshHomeLoan as AppContext['refreshHomeLoan'] });
  render(<Milestone />);
  // Distinct from the waiting spinner — an honest failure message.
  expect(screen.getByText("Couldn't load your balance.")).toBeTruthy();
  expect(screen.queryByText('Fetching your live balance…')).toBeNull();
  fireEvent.press(screen.getByText('Retry'));
  expect(refreshHomeLoan).toHaveBeenCalled();
});

// --- the Goal-tab entry point ------------------------------------------------

const GOAL = {
  original: 500000, balance: 432900, homeValue: 640000, startYear: 'Mar 2021',
  ratePct: 5.74, baseRepay: 1240, extra: 200, freedomDate: 'Aug 2045', aheadLabel: '4y 3m', interestSaved: 58200,
  lastRepay: { amount: 1440, principal: 1208, interest: 232, date: 'Today · 9:02am' },
};

it('navigates to /milestone from the Goal-tab drill-in', () => {
  mockState = state({ goal: GOAL as AppContext['goal'], fireRepayment: jest.fn() as AppContext['fireRepayment'] });
  render(<Goals />);
  fireEvent.press(screen.getByTestId('milestone-link'));
  expect(mockPush).toHaveBeenCalledWith('/milestone');
});
