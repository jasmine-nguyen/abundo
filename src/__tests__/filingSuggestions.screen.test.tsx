// WHIT-542 — the "make a rule?" suggestions inside the File-by-shop sheet.
//
// When the user has hand-filed a shop the same way on enough separate days, a suggestion card shows
// above the unfiled shop list. Tapping it opens the SAME add-rule confirm sheet the "type a new
// rule" flow uses (addRuleConfirm), carrying the server's pattern + category — so a habit mints a
// rule through the existing path, never a second one. What is pinned here:
//   - the suggestion renders its merchant, category and distinct-day count;
//   - it discloses what else the rule would sweep (alsoCatches), like the merchant screen;
//   - tapping it opens addRuleConfirm with the exact pattern + categoryId (no refetch);
//   - no suggestions -> no section (a caught-up user sees only their shops).
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import type { AppContext } from '../context';
import type { FilingSuggestion, UncategorizedMerchantGroup, UncategorizedMerchants } from '../api';

let mockState: AppContext;
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});
jest.mock('../queries', () => require('./support/screenQueryMocks').queryMocksFromState(() => mockState));

import { Overlays } from '../components/Overlays';

const fns = { setSheet: jest.fn(), showToast: jest.fn() };

const CATEGORIES = [
  { id: 'dining', name: 'Dining', bucket: 'Lifestyle', icon: 'food', color: '#F2994A', parent: null },
  { id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#7FD49B', parent: null },
];

// One unfiled shop so the sheet renders its main list view (an empty groups list shows the
// "every shop is filed" state instead, before the suggestions section).
const aShop: UncategorizedMerchantGroup = {
  merchant: 'Kmart', rulePattern: 'kmart', groupedBy: 'merchant', count: 3,
  samples: ['KMART 0421'], firstDate: '2026-07-01', lastDate: '2026-07-03', alsoCatches: [],
};
const merchants: UncategorizedMerchants = { unfiled: 3, groups: [aShop], ungrouped: { count: 0, samples: [] } };

const suggestion = (over: Partial<FilingSuggestion> = {}): FilingSuggestion => ({
  merchant: 'Seddons Eatery', rulePattern: 'SEDDONS EATERY', categoryId: 'dining',
  distinctDays: 5, alsoCatches: [], ...over,
});

function mountList(suggestions: FilingSuggestion[] | undefined) {
  mockState = {
    sheet: { mode: 'fileByShopList' }, toast: null, categories: CATEGORIES,
    uncategorizedMerchants: merchants, filingSuggestions: suggestions, ...fns,
  } as unknown as AppContext;
  return render(<Overlays />);
}

beforeEach(() => { jest.clearAllMocks(); });

it('renders a suggestion with its merchant, category and distinct-day count', () => {
  mountList([suggestion()]);
  expect(screen.getByTestId('filing-suggestions')).toBeTruthy();
  expect(screen.getByText('Seddons Eatery')).toBeTruthy();
  expect(screen.getByText('Filed as Dining on 5 separate days — make a rule?')).toBeTruthy();
});

it('discloses what else the rule would also sweep', () => {
  mountList([suggestion({ alsoCatches: [{ merchant: 'Seddons Deli', count: 2 }] })]);
  expect(screen.getByText('+ would also file 2 charges from 1 other shop')).toBeTruthy();
});

// The capture: tapping a suggestion opens the shared add-rule confirm sheet with the server's
// pattern + category. Fail-on-revert: pass the wrong pattern/category and this reddens.
it('opens the add-rule confirm sheet with the suggested pattern and category', () => {
  mountList([suggestion()]);
  fireEvent.press(screen.getByTestId('filing-suggestion'));
  expect(fns.setSheet).toHaveBeenCalledWith({
    mode: 'addRuleConfirm', pattern: 'SEDDONS EATERY', categoryId: 'dining', budgetExcluded: false,
  });
});

it('shows no suggestions section when there are none', () => {
  mountList([]);
  expect(screen.queryByTestId('filing-suggestions')).toBeNull();
  expect(screen.queryByTestId('filing-suggestion')).toBeNull();
});

it('shows no suggestions section while the suggestions are still loading (undefined)', () => {
  mountList(undefined);
  expect(screen.queryByTestId('filing-suggestions')).toBeNull();
});
