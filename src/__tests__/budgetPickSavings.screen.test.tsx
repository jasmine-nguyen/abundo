// WHIT-201 — Savings categories are NOT budgetable: savings is an account balance,
// not categorised spend, so a Savings target would render a permanently-empty bar.
// app/budget/pick.tsx excludes them from "Add a budget" (while Income stays pickable).
// Renders the real screen; reverting the filter makes test #1 fail.
import { describe, it, expect, jest } from '@jest/globals';
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import type { AppContext } from '../context';

let mockState: AppContext;
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});
jest.mock('../queries', () => require('./support/screenQueryMocks').queryMocksFromState(() => mockState));
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn(), back: jest.fn() }) }));

import BudgetPick from '../../app/budget/pick';

const SAVINGS = { id: 'nest_egg', name: 'Nest Egg', icon: 'home', color: '#C7A8F0', bucket: 'Savings', recent: 0 };
const INCOME = { id: 'salary', name: 'Salary', icon: 'briefcase', color: '#7fd49b', bucket: 'Income', recent: 4000 };
const SPEND = { id: 'coffee', name: 'Cafes & Coffee', icon: 'coffee', color: '#E8A87C', bucket: 'Lifestyle', recent: 52 };

function state(over: Partial<AppContext>): AppContext {
  return { categories: [], budgets: [], ...over } as unknown as AppContext;
}

describe('BudgetPick — Savings is not budgetable (WHIT-201)', () => {
  it('hides a Savings category while still listing spend and income categories', () => {
    mockState = state({ categories: [SAVINGS, INCOME, SPEND] as any, budgets: [] });
    render(<BudgetPick />);
    expect(screen.queryByText('Nest Egg')).toBeNull();        // Savings excluded
    expect(screen.getByText('Salary')).toBeTruthy();          // Income still pickable (WHIT-69)
    expect(screen.getByText('Cafes & Coffee')).toBeTruthy();  // spend still pickable
  });
});
