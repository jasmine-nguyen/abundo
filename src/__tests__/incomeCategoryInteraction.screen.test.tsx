// WHIT-158 (independent/adversarial half) — proves income categories are not just
// VISIBLE but actually SELECTABLE end-to-end: picking one in the Categorize picker
// advances the flow, and picking one in the New-rule sheet saves a rule with the
// income category id. Also locks the $0 sign boundary and the "empty Income group
// stays hidden" regression guard. The implementer's incomeCategory.screen.test.tsx
// only asserts the rows RENDER; these assert the behaviour behind the tap.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
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

const INCOME_CAT = { id: 'salary', name: 'Salary', icon: 'briefcase', color: '#35d9a0', bucket: 'Income', recent: 0 };
const SPEND_CAT = { id: 'groceries', name: 'Groceries', icon: 'cart', color: '#7fd49b', bucket: 'Living', recent: 0 };

const fns = {
  chooseCategory: jest.fn(), saveManualRule: jest.fn(), updateRule: jest.fn(),
  setSheet: jest.fn(), dismissNotif: jest.fn(), readSheetDraft: jest.fn(() => undefined), writeSheetDraft: jest.fn(),
};
beforeEach(() => { Object.values(fns).forEach((f) => f.mockClear()); });

describe('Categorize picker — income is pickable, not just visible (WHIT-158)', () => {
  function pickerState(tx: any): AppContext {
    return {
      sheet: { mode: 'picker', txId: tx.transaction_id },
      transactions: [tx], categories: [INCOME_CAT, SPEND_CAT],
      toast: null, notif: null, ...fns,
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
    toast: null, notif: null, ...fns,
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

// Icon-set invariants live in the screen project because ../icons pulls in
// react-native-svg (native), which the headless `logic` project can't load.
import { ICON, ICON_KEYS } from '../icons';

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
