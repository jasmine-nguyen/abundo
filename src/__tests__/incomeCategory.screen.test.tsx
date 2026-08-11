// WHIT-158 — income categories are first-class: they show in the Categories list
// (previously the Income bucket was filtered out), and they're pickable when
// categorising a transaction and when writing a rule. The Categorize sheet also
// shows the amount sign-aware, so a positive income transaction reads as +$, not -$.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import type { AppContext } from '../context';
// WHIT-459: icon-set invariants (folded from incomeCategoryInteraction) live in the screen project
// because ../icons pulls in react-native-svg (native), which the headless `logic` project can't load.
import { ICON, ICON_KEYS } from '../icons';

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
  setSheet: jest.fn(), readSheetDraft: () => undefined, writeSheetDraft: () => {},
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
    toast: null, category: (id: string) => [INCOME_CAT, SPEND_CAT].find((c) => c.id === id),
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
      categories: cats, toast: null,
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
    toast: null, ...sheetFns,
  } as unknown as AppContext;
  render(<Overlays />);
  expect(screen.getByText('Salary')).toBeTruthy();
});

// ===== WHIT-158 (folded from incomeCategoryInteraction.screen.test.tsx)
// Original mocked ../context + ../queries + expo-router with factory bodies byte-identical to this
// survivor's (hoisted once above; not duplicated). Its module-level fixtures diverged — a different
// INCOME_CAT color seed (#35d9a0 vs #7fd49b) and a different `fns` stub (readSheetDraft/writeSheetDraft
// as jest.fn) with a beforeEach that clears them — so they're pushed down into this block-scoped child
// describe. INCOME_CAT shadows the module-level const (color is never asserted; inert). SPEND_CAT is
// byte-identical to the survivor's, so it is reused from module scope, not redeclared. The shared
// `let mockState` is re-seeded inside each test as before.
describe('WHIT-158 income category interaction (folded)', () => {
  const INCOME_CAT = { id: 'salary', name: 'Salary', icon: 'briefcase', color: '#35d9a0', bucket: 'Income', recent: 0 };

  const fns = {
    chooseCategory: jest.fn(), saveManualRule: jest.fn(), updateRule: jest.fn(),
    setSheet: jest.fn(), readSheetDraft: jest.fn(() => undefined), writeSheetDraft: jest.fn(),
  };
  beforeEach(() => { Object.values(fns).forEach((f) => f.mockClear()); });

  describe('Categorize picker — income is pickable, not just visible (WHIT-158)', () => {
    function pickerState(tx: any): AppContext {
      return {
        sheet: { mode: 'picker', txId: tx.transaction_id },
        transactions: [tx], categories: [INCOME_CAT, SPEND_CAT],
        toast: null, ...fns,
      } as unknown as AppContext;
    }

    it('tapping the income row advances the flow (chooseCategory with the income id)', () => {
      mockState = pickerState({ transaction_id: 't1', amount: 5000, description: 'ACME PAYROLL' });
      render(<Overlays />);
      fireEvent.press(screen.getByText('Salary'));
      expect(fns.chooseCategory).toHaveBeenCalledWith('salary'); // was filtered out pre-WHIT-158
    });

    it('a $0 transaction reads as +$0.00, not -$0.00 (sign boundary)', () => {
      mockState = pickerState({ transaction_id: 't0', amount: 0, description: 'ADJUSTMENT' });
      render(<Overlays />);
      expect(screen.getByText('+$0.00')).toBeTruthy(); // old hardcoded "-$" would show -$0.00
    });
  });

  it('New-rule sheet: an income category can be selected AND saved (WHIT-158)', () => {
    mockState = {
      sheet: { mode: 'addrule' }, rules: [], categories: [INCOME_CAT, SPEND_CAT],
      toast: null, ...fns,
    } as unknown as AppContext;
    render(<Overlays />);
    fireEvent.changeText(screen.getByPlaceholderText('e.g. NETFLIX'), 'PAYROLL');
    fireEvent.press(screen.getByText('Salary'));   // income pill now offered
    fireEvent.press(screen.getByText('Add rule'));
    expect(fns.saveManualRule).toHaveBeenCalledWith('PAYROLL', 'salary');
  });

  describe('Categories list — Income group visibility (WHIT-158)', () => {
    it('hides the Income header when there are no income categories (regression guard)', () => {
      mockState = { categories: [SPEND_CAT], budgets: [], categoriesLoading: false } as unknown as AppContext;
      render(<CategoryList />);
      expect(screen.queryByText('Income')).toBeNull(); // .filter(g => g.items.length) must still hold
      expect(screen.getByText('Groceries')).toBeTruthy();
    });
  });

  describe('icon set (WHIT-158)', () => {
    it('every ICON_KEYS entry has a real glyph — no silent "q" fallback', () => {
      expect(ICON_KEYS.filter((k) => !(k in ICON))).toEqual([]);
    });

    it('includes the 8 new WHIT-158 icons, each drawable', () => {
      for (const k of ['briefcase', 'cash', 'bank', 'coins', 'heart', 'star', 'music', 'medical']) {
        expect(ICON_KEYS).toContain(k);
        expect(ICON[k]).toBeTruthy();
      }
    });
  });
});
