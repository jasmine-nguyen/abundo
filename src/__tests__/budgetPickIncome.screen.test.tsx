// WHIT-69 (authored by qa) — app/budget/pick.tsx now lists Income categories in
// "Add a budget" (the c.bucket !== 'Income' filter was removed) while still hiding
// categories that already have a budget. Renders the real screen; reverting the
// filter fails test #1. The existing incomeCategory*.screen tests exercise the
// Categorize sheet, NOT this "Add a budget" screen, so this is a genuine gap.
import { describe, it, expect, jest } from '@jest/globals';
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import type { ScreenState } from './support/screenQueryMocks';

let mockState: ScreenState;
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});
jest.mock('../queries', () => require('./support/screenQueryMocks').queryMocksFromState(() => mockState));
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn(), back: jest.fn() }) }));

import BudgetPick from '../../app/budget/pick';

const INCOME = { id: 'salary', name: 'Salary', icon: 'briefcase', color: '#7fd49b', bucket: 'Income', recent: 4000 };
const SIDE = { id: 'side_gig', name: 'Side Gig', icon: 'briefcase', color: '#7fd49b', bucket: 'Income', recent: 300 };
const SPEND = { id: 'coffee', name: 'Cafes & Coffee', icon: 'coffee', color: '#E8A87C', bucket: 'Lifestyle', recent: 52 };

function state(over: Partial<ScreenState>): ScreenState {
  return { categories: [], budgets: [], ...over };
}

describe('BudgetPick — income is pickable (WHIT-69)', () => {
  it('lists an Income category alongside spend categories', () => {
    mockState = state({ categories: [INCOME, SPEND] as any, budgets: [] });
    render(<BudgetPick />);
    expect(screen.getByText('Salary')).toBeTruthy();          // was filtered out pre-WHIT-69
    expect(screen.getByText('Cafes & Coffee')).toBeTruthy();  // control: spend still listed
  });

  it('still hides an income category that already has a budget', () => {
    mockState = state({ categories: [INCOME, SIDE] as any, budgets: [{ id: 'salary' } as any] });
    render(<BudgetPick />);
    expect(screen.queryByText('Salary')).toBeNull();          // already budgeted → excluded
    expect(screen.getByText('Side Gig')).toBeTruthy();        // not budgeted → still pickable
  });

  // WHIT-169: an income row must NOT show its spend `recent` (4000) as an average —
  // it shows an "earn-target" tag instead. A spend row still shows its avg.
  it('shows "earn-target" for income rows, not a spend average, while spend rows keep theirs', () => {
    mockState = state({ categories: [INCOME, SPEND] as any, budgets: [] });
    render(<BudgetPick />);
    expect(screen.getByText('earn-target')).toBeTruthy();     // income row's right side
    expect(screen.queryByText('$4,000')).toBeNull();          // income spend-avg suppressed
    expect(screen.getByText('$52')).toBeTruthy();             // spend control row keeps its avg
    expect(screen.getByText('avg / fortnight')).toBeTruthy(); // ...and its label
  });
});
