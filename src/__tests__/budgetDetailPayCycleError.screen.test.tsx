// WHIT-72 GAP (adversarial half, authored by qa) — the budget-detail screen's
// blank-on-payCycleError branch (`if (!bd || d.payCycleError)` in app/budget/[id].tsx).
// No existing test renders app/budget/[id].tsx at all, so this locks BOTH directions with
// a VALID budget present (bd non-null) so the blank is attributable to payCycleError alone,
// not a cold cache: payCycleError=true → blank Header only; payCycleError=false → the full
// detail (Edit + category + RELATED TRANSACTIONS). Fail-on-revert: drop `|| d.payCycleError`
// and the first case renders the full detail against the DEFAULT cycle → the assertion trips.
// ../queries re-routed via the shared screenQueryMocks harness; expo-router stubbed.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import type { ScreenState } from './support/screenQueryMocks';

let mockState: ScreenState;
jest.mock('../queries', () => require('./support/screenQueryMocks').queryMocksFromState(() => mockState));

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => ({ id: 'coffee' }),
}));

import BudgetDetail from '../../app/budget/[id]';

// A valid, non-Savings/Income category + its budget row → budgetDetail() returns non-null,
// so bd is present in BOTH tests and only payCycleError decides whether the screen blanks.
const CATS = [{ id: 'coffee', name: 'Cafes & Coffee', bucket: 'Lifestyle', icon: 'coffee', color: '#E8A87C', recent: 0 }];
const BUDGETS = [{ id: 'coffee', budget: 100, posted: 40, pending: 10 }];

beforeEach(() => {
  mockState = { categories: CATS, budgets: BUDGETS, transactions: [], cycleLen: 30, daysLeft: 12, payCycleError: false };
});

it('payCycleError=true → the screen blanks (Header only), no detail card and no Edit (never a wrong-cycle detail)', () => {
  mockState = { ...mockState, payCycleError: true };
  render(<BudgetDetail />);
  expect(screen.queryByText('Edit')).toBeNull();                  // the full detail is NOT rendered
  expect(screen.queryByText('RELATED TRANSACTIONS')).toBeNull();
  expect(screen.queryByText('Cafes & Coffee')).toBeNull();
});

it('payCycleError=false with a valid budget → the full detail renders (regression guard)', () => {
  render(<BudgetDetail />);
  expect(screen.getByText('Edit')).toBeTruthy();
  expect(screen.getByText('Cafes & Coffee')).toBeTruthy();
  expect(screen.getByText('RELATED TRANSACTIONS')).toBeTruthy();
});
