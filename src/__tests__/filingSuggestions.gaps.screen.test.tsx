// WHIT-542 GAP tests — the "make a rule?" suggestion card, adversarial rendering edges the
// implementer's filingSuggestions.screen.test.tsx does not cover:
//   [Gc1] a suggestion whose category id is NOT in the client taxonomy -> "a category" fallback
//         (the server's winning category can be one this device hasn't synced yet);
//   [Gc2] an alsoCatches list with a NULL-merchant sweep line + a second shop -> the summary counts
//         charges and pluralises "shops" without crashing on the null merchant name;
//   [Gc3] the SAME merchant appearing as an unfiled shop AND a hand-filed suggestion -> both render.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { screen, fireEvent } from '@testing-library/react-native';
import type { AppContext } from '../context';
import type { FilingSuggestion, UncategorizedMerchantGroup, UncategorizedMerchants } from '../api';

let mockState: AppContext;
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});
jest.mock('../auth', () => require('./support/authMock').authMockModule());

import { resetAuth } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient } from './support/renderWithQueries';
import { openOverlays } from './support/openOverlays';

const server = installFakeServer();
useTestQueryClient();

const fns = { setSheet: jest.fn(), showToast: jest.fn() };

const CATEGORIES = [
  { id: 'dining', name: 'Dining', bucket: 'Lifestyle', icon: 'food', color: '#F2994A', parent: null },
  { id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#7FD49B', parent: null },
];

const aShop: UncategorizedMerchantGroup = {
  merchant: 'Kmart', rulePattern: 'kmart', groupedBy: 'merchant', count: 3,
  samples: ['KMART 0421'], firstDate: '2026-07-01', lastDate: '2026-07-03', alsoCatches: [],
};
const merchants: UncategorizedMerchants = { unfiled: 3, groups: [aShop], ungrouped: { count: 0, samples: [] } };

const suggestion = (over: Partial<FilingSuggestion> = {}): FilingSuggestion => ({
  merchant: 'Seddons Eatery', rulePattern: 'SEDDONS EATERY', categoryId: 'dining',
  distinctDays: 5, alsoCatches: [], ...over,
});

// Opens the list and waits for the suggestions section, which loads once the sheet opens.
async function mountList(suggestions: FilingSuggestion[]) {
  server.seed('/categories', CATEGORIES);
  server.seed('/transactions/uncategorized/merchants', merchants);
  server.seed('/transactions/filing-suggestions', { suggestions });
  const state = { sheet: { mode: 'fileByShopList' }, toast: null, ...fns } as unknown as AppContext;
  await openOverlays(state, (next) => { mockState = next; });
  await screen.findByTestId('file-by-shop-group');
  await screen.findByTestId('filing-suggestions');
}

beforeEach(() => {
  jest.clearAllMocks();
  resetAuth();
});

// [Gc1] Fail-on-revert for the `?? 'a category'` fallback: a winning category the client hasn't
// synced (category(id) === undefined) must read "a category", never a blank or a crash.
it('falls back to "a category" when the suggested category is not in the taxonomy', async () => {
  await mountList([suggestion({ categoryId: 'petrol' })]); // petrol not in CATEGORIES
  expect(screen.getByText('Filed as a category on 5 separate days — make a rule?')).toBeTruthy();
  // still tappable and still carries the raw categoryId to the mint flow
  fireEvent.press(screen.getByTestId('filing-suggestion'));
  expect(fns.setSheet).toHaveBeenCalledWith({
    mode: 'addRuleConfirm', pattern: 'SEDDONS EATERY', categoryId: 'petrol', budgetExcluded: false,
  });
});

// [Gc2] A null-merchant sweep line (the nameless "PAYPAL *COLES ONLINE" disclosure the server
// returns as merchant: null) must not break the summary; it sums charges and pluralises shops.
it('renders the also-sweep summary with a null-merchant line and pluralises shops', async () => {
  await mountList([suggestion({ alsoCatches: [{ merchant: null, count: 3 }, { merchant: 'Coles Express', count: 2 }] })]);
  expect(screen.getByText('+ would also file 5 charges from 2 other shops')).toBeTruthy();
});

// [Gc3] Interplay: a merchant can be BOTH a still-unfiled shop and a hand-filed habit. Both the
// suggestion card and the unfiled shop row render — the suggestion never replaces the shop list.
it('shows a suggestion and the unfiled shop list together for the same merchant', async () => {
  await mountList([suggestion({ merchant: 'Kmart', rulePattern: 'KMART', categoryId: 'groceries' })]);
  expect(screen.getByTestId('filing-suggestions')).toBeTruthy();
  expect(screen.getByTestId('filing-suggestion')).toBeTruthy();
  // 'Kmart' appears twice: once as the suggestion, once as the unfiled shop row.
  expect(screen.getAllByText('Kmart').length).toBe(2);
});
