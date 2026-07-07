// WHIT-169 (qa, adversarial gap) — app/budget/edit.tsx must GATE the spend UI for an
// income category: no recommend button, no "Recommended: $X" line, "View earning
// history", dashed stats — while a spend category keeps all of it. The selector is
// locked in selectors.logic.test.ts; NO screen test proves edit.tsx wires it, so
// un-gating the button (edit.tsx recommend Pressable) or the prompt ternary slips
// through. Renders the real screen with the REAL budgetEditInfo, so a revert fails.
import { describe, it, expect, jest } from '@jest/globals';
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import type { AppContext } from '../context';

let mockState: AppContext;
let mockParams: { categoryId: string } = { categoryId: 'salary' };

jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});
jest.mock('../queries', () => require('./support/screenQueryMocks').queryMocksFromState(() => mockState));
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), dismissAll: jest.fn() }),
  useLocalSearchParams: () => mockParams,
}));

import BudgetEdit from '../../app/budget/edit';

const INCOME = { id: 'salary', name: 'Salary', icon: 'briefcase', color: '#7fd49b', bucket: 'Income', recent: 0 };
const SPEND = { id: 'coffee', name: 'Cafes & Coffee', icon: 'coffee', color: '#E8A87C', bucket: 'Lifestyle', recent: 52 };

function state(cats: any[]): AppContext {
  return {
    categories: cats,
    budgets: [],
    category: (id: string) => cats.find((c) => c.id === id),
    cycleName: () => 'Fortnightly',
  } as unknown as AppContext;
}

describe('BudgetEdit — income framing is wired into the screen (WHIT-169)', () => {
  it('income category: prompt shown, recommend button + "Recommended:" line absent, earning history, dashed stats', () => {
    mockParams = { categoryId: 'salary' };
    mockState = state([INCOME]);
    render(<BudgetEdit />);

    expect(screen.getByText('Set your income floor')).toBeTruthy();     // recPrompt (else-branch)
    expect(screen.queryByText(/^Recommended:/)).toBeNull();             // no spend recommendation line
    expect(screen.queryByText('Use my average spend')).toBeNull();      // recommend button gated OFF
    expect(screen.queryByText('Use my average income')).toBeNull();     // ...and no income-CTA button either
    expect(screen.getByText('View earning history')).toBeTruthy();      // historyToggleLabel
    expect(screen.getAllByText('—')).toHaveLength(2);                   // Last + 6-cycle stats both dashed, never "$0"
  });

  it('spend category (control): recommendation line + button + spending history all present', () => {
    mockParams = { categoryId: 'coffee' };
    mockState = state([SPEND]);
    render(<BudgetEdit />);

    expect(screen.getByText('Recommended: $52')).toBeTruthy();          // real spend recommendation
    expect(screen.getByText('Use my average spend')).toBeTruthy();      // recommend button present
    expect(screen.getByText('View spending history')).toBeTruthy();     // spend history label
    expect(screen.queryByText('Set your income floor')).toBeNull();     // no income prompt
    expect(screen.queryByText('View earning history')).toBeNull();
  });
});

describe('BudgetEdit — a Savings category lands on a "can\'t budget" state (WHIT-202)', () => {
  it('Savings category: shows the explanatory note, none of the amount/history/save UI', () => {
    // A deep-link to /budget/edit on a Savings category must NOT show an amount field whose
    // save is doomed to a 400 — it shows a coherent "can't budget" note instead. Fail-on-
    // revert: removing the early-return falls through to the full spend screen (history +
    // stats reappear, note gone).
    const SAVINGS = { id: 'nest_egg', name: 'Nest Egg', icon: 'piggy', color: '#8fd4c0', bucket: 'Savings', recent: 0 };
    mockParams = { categoryId: 'nest_egg' };
    mockState = state([SAVINGS]);
    render(<BudgetEdit />);

    expect(screen.getByText('Nest Egg')).toBeTruthy();                              // category header still shown
    expect(screen.getByText(/Savings categories can't be budgeted/)).toBeTruthy();  // the note
    expect(screen.queryByText('View spending history')).toBeNull();                 // no spend UI...
    expect(screen.queryByText('6-cycle average')).toBeNull();                       // ...no stats/amount field
    expect(screen.queryByText('View earning history')).toBeNull();
  });
});
