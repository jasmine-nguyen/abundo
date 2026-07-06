// WHIT-197 GAP (milestone hero state machine) — the window the milestone.screen suite
// leaves open: a balance is KNOWN (last-good, cached) while the balance read is itself in
// an error state (a failed focus/Retry refetch). The hero precedence is `hasBalance ?
// schedule : homeLoanError ? error : spinner` (milestone.tsx:40-75), so a known balance
// must WIN — show the last-good balance + plan, and swallow the refetch error rather than
// nagging. Reverting to `homeLoanError ? error : (hasBalance ? ...)` turns this red.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { makeGoalData } from './factory';
import type { GoalScreenData } from '../queries';

let mockGoal: GoalScreenData;
jest.mock('../queries', () => ({ useGoalScreenData: () => mockGoal }));
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ fireRepayment: jest.fn() }) };
});
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn(), back: jest.fn() }), useFocusEffect: () => {} }));

import Milestone from '../../app/milestone';

beforeEach(() => { mockGoal = makeGoalData(); });

it('a known (last-good) balance WINS over a refetch error — shows the balance, not the error', () => {
  // TanStack keeps the last successful `data` when a refetch errors, so homeLoan.balance is
  // present AND homeLoanError is true simultaneously. hasBalance must take precedence.
  mockGoal = makeGoalData({ homeLoan: { balance: 596642.43, asOf: '2026-07-04T00:24:37.614Z' }, homeLoanError: true, isError: true });
  render(<Milestone />);
  expect(screen.getByText('$596,642')).toBeTruthy();                 // last-good balance still shown
  expect(screen.getByText('The 36-month plan')).toBeTruthy();        // plan still renders
  expect(screen.queryByText("Couldn't load your balance.")).toBeNull(); // error is swallowed, not surfaced
  expect(screen.queryByText('Fetching your live balance…')).toBeNull();
});
