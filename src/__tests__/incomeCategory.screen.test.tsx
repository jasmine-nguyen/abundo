// WHIT-158 — income categories are first-class: they show in the Categories list
// (previously the Income bucket was filtered out), and they're pickable when
// categorising a transaction and when writing a rule. The Categorize sheet also
// shows the amount sign-aware, so a positive income transaction reads as +$, not -$.
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

import CategoryList from '../../app/category/index';
import { Overlays } from '../components/Overlays';

const INCOME_CAT = { id: 'salary', name: 'Salary', icon: 'briefcase', color: '#7fd49b', bucket: 'Income', recent: 0 };
const SPEND_CAT = { id: 'groceries', name: 'Groceries', icon: 'cart', color: '#7fd49b', bucket: 'Living', recent: 0 };

const sheetFns = {
  chooseCategory: jest.fn(), saveManualRule: jest.fn(), updateRule: jest.fn(),
  setSheet: jest.fn(), dismissNotif: jest.fn(),
};

it('Categories list renders the Income group + its categories (WHIT-158)', () => {
  mockState = { categories: [INCOME_CAT, SPEND_CAT], budgets: [], categoriesLoading: false } as unknown as AppContext;
  render(<CategoryList />);
  expect(screen.getByText('Income')).toBeTruthy();   // the bucket header (was filtered out)
  expect(screen.getByText('Salary')).toBeTruthy();   // the income category itself
});

it('does not badge a Savings category as "budgeted", even with a phantom target (WHIT-202)', () => {
  // A Savings category can't be budgeted, so a "budgeted" badge on one lies (the target
  // is un-manageable in-app). Seed BOTH a legit spend budget and a Savings phantom row:
  // exactly one badge must render — proving the badge still works AND that Savings is
  // suppressed. Fail-on-revert: dropping the `c.bucket !== 'Savings'` guard shows two.
  const SAVINGS_CAT = { id: 'nest_egg', name: 'Nest Egg', icon: 'piggy', color: '#8fd4c0', bucket: 'Savings', recent: 0 };
  mockState = {
    categories: [SPEND_CAT, SAVINGS_CAT],
    budgets: [{ id: 'groceries' }, { id: 'nest_egg' }], // nest_egg = a pre-guard phantom row
    categoriesLoading: false,
  } as unknown as AppContext;
  render(<CategoryList />);
  expect(screen.getByText('Nest Egg')).toBeTruthy();          // the category still lists...
  expect(screen.queryAllByText('budgeted')).toHaveLength(1);  // ...but only groceries is badged
});

function pickerState(tx: any): AppContext {
  return {
    sheet: { mode: 'picker', txId: tx.transaction_id },
    transactions: [tx], categories: [INCOME_CAT, SPEND_CAT],
    toast: null, notif: null, category: (id: string) => [INCOME_CAT, SPEND_CAT].find((c) => c.id === id),
    ...sheetFns,
  } as unknown as AppContext;
}

describe('Categorize picker (WHIT-158)', () => {
  it('offers income categories when categorising a transaction', () => {
    mockState = pickerState({ transaction_id: 't1', amount: 5000, description: 'ACME PAYROLL' });
    render(<Overlays />);
    expect(screen.getByText('Salary')).toBeTruthy();     // income now pickable
    expect(screen.getByText('Groceries')).toBeTruthy();
  });

  it('shows a POSITIVE income amount as +$ (not a hardcoded -$)', () => {
    mockState = pickerState({ transaction_id: 't1', amount: 5000, description: 'ACME PAYROLL' });
    render(<Overlays />);
    expect(screen.getByText('+$5,000.00')).toBeTruthy();
  });

  it('still shows a spend amount as -$', () => {
    mockState = pickerState({ transaction_id: 't2', amount: -52.5, description: 'WOOLWORTHS' });
    render(<Overlays />);
    expect(screen.getByText('-$52.50')).toBeTruthy();
  });

  it('lists categories alphabetically, so a newly-created one is not stranded at the bottom', () => {
    // Supplied in creation order (Zebra, Apple, Mango) -> must render sorted.
    const cats = [
      { id: 'z', name: 'Zebra', icon: 'tag', color: '#fff', bucket: 'Lifestyle', recent: 0 },
      { id: 'a', name: 'Apple', icon: 'tag', color: '#fff', bucket: 'Lifestyle', recent: 0 },
      { id: 'm', name: 'Mango', icon: 'tag', color: '#fff', bucket: 'Lifestyle', recent: 0 },
    ];
    mockState = {
      sheet: { mode: 'picker', txId: 't1' },
      transactions: [{ transaction_id: 't1', amount: -10, description: 'X' }],
      categories: cats, toast: null, notif: null,
      category: (id: string) => cats.find((c) => c.id === id), ...sheetFns,
    } as unknown as AppContext;
    render(<Overlays />);
    const names = screen.getAllByTestId('pickerCatName').map((n) => n.props.children);
    expect(names).toEqual(['Apple', 'Mango', 'Zebra']);
  });
});

it('the rule sheet also offers income categories (WHIT-158)', () => {
  mockState = {
    sheet: { mode: 'addrule' }, rules: [], categories: [INCOME_CAT, SPEND_CAT],
    toast: null, notif: null, ...sheetFns,
  } as unknown as AppContext;
  render(<Overlays />);
  expect(screen.getByText('Salary')).toBeTruthy();
});
