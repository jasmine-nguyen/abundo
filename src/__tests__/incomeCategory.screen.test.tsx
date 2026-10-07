// WHIT-158 — income categories are first-class: they show in the Categories list
// (previously the Income bucket was filtered out), and they're pickable when
// categorising a transaction and when writing a rule. The Categorize sheet also
// shows the amount sign-aware, so a positive income transaction reads as +$, not -$.
// Client state and writers come from the mocked context; the categories, budgets, rules and the
// tapped charge come from the fake server through the real query hooks (WHIT-670).
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { screen, fireEvent } from '@testing-library/react-native';
import type { AppContext } from '../context';
// WHIT-459: icon-set invariants (folded from incomeCategoryInteraction) live in the screen project
// because ../icons pulls in react-native-svg (native), which the headless `logic` project can't load.
import { ICON, ICON_KEYS } from '../icons';

let mockState: AppContext;
jest.mock('../context', () => require('./support/contextMock').realContextWith(() => mockState));
jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import CategoryList from '../../app/category/index';
import { resetAuth } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { GROCERIES_TOP_RECORD } from './support/categories';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { openOverlays } from './support/openOverlays';

const server = installFakeServer();
useTestQueryClient();

beforeEach(() => resetAuth());

const INCOME_CAT = { id: 'salary', name: 'Salary', icon: 'briefcase', bucket: 'Income', parent: null };

const sheetFns = {
  chooseCategory: jest.fn(), saveManualRule: jest.fn(), updateRule: jest.fn(),
  setSheet: jest.fn(), readSheetDraft: () => undefined, writeSheetDraft: () => {},
};

const setMockState = (next: AppContext) => { mockState = next; };

// The picker resolves the tapped charge from the feed and the recent list; seed both.
function seedTransactions(transactions: unknown[]) {
  server.seed('/transactions', transactions);
  server.seed('/transactions/feed', { transactions, nextCursor: null });
}

function openPicker(tx: any, fns: Record<string, unknown>, categories: unknown[] = [INCOME_CAT, GROCERIES_TOP_RECORD]) {
  server.seed('/categories', categories);
  seedTransactions([tx]);
  const state = { sheet: { mode: 'picker', txId: tx.transaction_id }, toast: null, ...fns } as unknown as AppContext;
  return openOverlays(state, setMockState);
}

function openRuleSheet(fns: Record<string, unknown>) {
  server.seed('/categories', [INCOME_CAT, GROCERIES_TOP_RECORD]);
  server.seed('/rules', []);
  const state = { sheet: { mode: 'addrule' }, toast: null, ...fns } as unknown as AppContext;
  return openOverlays(state, setMockState);
}

it('Categories list renders the Income group + its categories (WHIT-158)', async () => {
  server.seed('/categories', [INCOME_CAT, GROCERIES_TOP_RECORD]);
  await renderWithQueries(<CategoryList />);
  expect(screen.getByText('Income')).toBeTruthy();   // the bucket header (was filtered out)
  expect(screen.getByText('Salary')).toBeTruthy();   // the income category itself
});

it('does not badge a Savings category as "budgeted", even with a phantom target (WHIT-202)', async () => {
  // A Savings category can't be budgeted, so a "budgeted" badge on one lies (the target
  // is un-manageable in-app). Seed BOTH a legit spend budget and a Savings phantom row:
  // exactly one badge must render — proving the badge still works AND that Savings is
  // suppressed. Fail-on-revert: dropping the `c.bucket !== 'Savings'` guard shows two.
  const SAVINGS_CAT = { id: 'nest_egg', name: 'Nest Egg', icon: 'piggy', bucket: 'Savings', parent: null };
  server.seed('/categories', [GROCERIES_TOP_RECORD, SAVINGS_CAT]);
  server.seed('/budgets', {
    groceries: { target: 100, posted: 0, pending: 0 },
    nest_egg: { target: 50, posted: 0, pending: 0 }, // a pre-guard phantom row
  });
  await renderWithQueries(<CategoryList />);
  expect(screen.getByText('Nest Egg')).toBeTruthy();          // the category still lists...
  expect(screen.queryAllByText('budgeted')).toHaveLength(1);  // ...but only groceries is badged
});

describe('Categorize picker (WHIT-158)', () => {
  it('offers income categories when categorising a transaction', async () => {
    await openPicker({ transaction_id: 't1', amount: 5000, description: 'ACME PAYROLL' }, sheetFns);
    expect(screen.getByText('Salary')).toBeTruthy();     // income now pickable
    expect(screen.getByText('Groceries')).toBeTruthy();
  });

  it('shows a POSITIVE income amount as +$ (not a hardcoded -$)', async () => {
    await openPicker({ transaction_id: 't1', amount: 5000, description: 'ACME PAYROLL' }, sheetFns);
    expect(screen.getByText('+$5,000.00')).toBeTruthy();
  });

  it('still shows a spend amount as -$', async () => {
    await openPicker({ transaction_id: 't2', amount: -52.5, description: 'WOOLWORTHS' }, sheetFns);
    expect(screen.getByText('-$52.50')).toBeTruthy();
  });

  it('lists categories alphabetically, so a newly-created one is not stranded at the bottom', async () => {
    // Supplied in creation order (Zebra, Apple, Mango) -> must render sorted.
    const cats = [
      { id: 'z', name: 'Zebra', icon: 'tag', bucket: 'Lifestyle', parent: null },
      { id: 'a', name: 'Apple', icon: 'tag', bucket: 'Lifestyle', parent: null },
      { id: 'm', name: 'Mango', icon: 'tag', bucket: 'Lifestyle', parent: null },
    ];
    await openPicker({ transaction_id: 't1', amount: -10, description: 'X' }, sheetFns, cats);
    const names = screen.getAllByTestId('pickerCat-name').map((n) => n.props.children);
    expect(names).toEqual(['Apple', 'Mango', 'Zebra']);
  });
});

it('the rule sheet also offers income categories (WHIT-158)', async () => {
  await openRuleSheet(sheetFns);
  expect(screen.getByText('Salary')).toBeTruthy();
});

// ===== WHIT-158 (folded from incomeCategoryInteraction.screen.test.tsx)
// Original mocked ../context + expo-router with factory bodies byte-identical to this survivor's
// (hoisted once above; not duplicated). Its `fns` stub diverged (readSheetDraft/writeSheetDraft as
// jest.fn) with a beforeEach that clears them, so it is pushed down into this block-scoped child
// describe. The shared `let mockState` is re-seeded inside each test as before.
describe('WHIT-158 income category interaction (folded)', () => {
  const fns = {
    chooseCategory: jest.fn(), saveManualRule: jest.fn(), updateRule: jest.fn(),
    setSheet: jest.fn(), readSheetDraft: jest.fn(() => undefined), writeSheetDraft: jest.fn(),
  };
  beforeEach(() => { Object.values(fns).forEach((f) => f.mockClear()); });

  describe('Categorize picker — income is pickable, not just visible (WHIT-158)', () => {
    it('tapping the income row advances the flow (chooseCategory with the income id)', async () => {
      await openPicker({ transaction_id: 't1', amount: 5000, description: 'ACME PAYROLL' }, fns);
      fireEvent.press(screen.getByText('Salary'));
      expect(fns.chooseCategory).toHaveBeenCalledWith('salary'); // was filtered out pre-WHIT-158
    });

    it('a $0 transaction reads as +$0.00, not -$0.00 (sign boundary)', async () => {
      await openPicker({ transaction_id: 't0', amount: 0, description: 'ADJUSTMENT' }, fns);
      expect(screen.getByText('+$0.00')).toBeTruthy(); // old hardcoded "-$" would show -$0.00
    });
  });

  it('New-rule sheet: an income category can be selected AND submitted (WHIT-158)', async () => {
    await openRuleSheet(fns);
    fireEvent.changeText(screen.getByPlaceholderText('e.g. NETFLIX'), 'PAYROLL');
    fireEvent.press(screen.getByText('Salary'));   // income pill now offered
    fireEvent.press(screen.getByText('Add rule'));
    // WHIT-538: a new rule now opens the preview/confirm step, which owns the save.
    expect(fns.setSheet).toHaveBeenCalledWith({ mode: 'addRuleConfirm', pattern: 'PAYROLL', categoryId: 'salary', budgetExcluded: false });
  });

  describe('Categories list — Income group visibility (WHIT-158)', () => {
    it('hides the Income header when there are no income categories (regression guard)', async () => {
      server.seed('/categories', [GROCERIES_TOP_RECORD]);
      await renderWithQueries(<CategoryList />);
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
