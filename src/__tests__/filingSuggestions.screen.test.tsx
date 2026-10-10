// WHIT-542 — the "make a rule?" suggestions inside the File-by-shop sheet.
//
// When the user has hand-filed a shop the same way on enough separate days, a suggestion card shows
// above the unfiled shop list. Tapping it opens the SAME add-rule confirm sheet the "type a new
// rule" flow uses (addRuleConfirm), carrying the server's pattern + category — so a habit mints a
// rule through the existing path, never a second one. What is pinned here:
//   - tapping it opens addRuleConfirm with the exact pattern + categoryId (no refetch);
//   - a null-merchant "also sweeps" line from the server doesn't break the card.
import { it, expect, jest, beforeEach } from '@jest/globals';
import { screen, fireEvent, act } from '@testing-library/react-native';
import type { AppContext } from '../context';
import type { FilingSuggestion, UncategorizedMerchantGroup, UncategorizedMerchants } from '../api';

let mockState: AppContext;
jest.mock('../context', () => require('./support/contextMock').realContextWith(() => mockState));
jest.mock('../auth', () => require('./support/authMock').authMockModule());

import { resetAuth } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { GROCERIES_TOP } from './support/categories';
import { useTestQueryClient } from './support/renderWithQueries';
import { openOverlays } from './support/openOverlays';

const server = installFakeServer();
useTestQueryClient();

const SUGGESTIONS = '/transactions/filing-suggestions';

const fns = { setSheet: jest.fn(), showToast: jest.fn() };

const CATEGORIES = [
  { id: 'dining', name: 'Dining', bucket: 'Lifestyle', icon: 'food', color: '#F2994A', parent: null },
  GROCERIES_TOP,
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

// Opens the list and waits until the shop row (and the suggestions fetched alongside it) has loaded.
async function mountList(suggestions: FilingSuggestion[]) {
  server.seed('/categories', CATEGORIES);
  server.seed('/transactions/uncategorized/merchants', merchants);
  server.seed(SUGGESTIONS, { suggestions });
  const state = { sheet: { mode: 'fileByShopList' }, toast: null, ...fns } as unknown as AppContext;
  await openOverlays(state, (next) => { mockState = next; });
  await screen.findByTestId('file-by-shop-group');
  await act(async () => {});
}

beforeEach(() => {
  jest.clearAllMocks();
  resetAuth();
});

// The capture: tapping a suggestion opens the shared add-rule confirm sheet with the server's
// pattern + category. Fail-on-revert: pass the wrong pattern/category and this reddens.
it('opens the add-rule confirm sheet with the suggested pattern and category', async () => {
  await mountList([suggestion()]);
  fireEvent.press(await screen.findByTestId('filing-suggestion'));
  expect(fns.setSheet).toHaveBeenCalledWith({
    mode: 'addRuleConfirm', pattern: 'SEDDONS EATERY', categoryId: 'dining', budgetExcluded: false,
  });
});

// [Gc2] The server returns a nameless sweep line (e.g. "PAYPAL *COLES ONLINE") as merchant: null;
// the card must still render and stay tappable.
it('renders a suggestion whose also-sweep list has a null-merchant line', async () => {
  await mountList([suggestion({ alsoCatches: [{ merchant: null, count: 3 }, { merchant: 'Coles Express', count: 2 }] })]);
  fireEvent.press(await screen.findByTestId('filing-suggestion'));
  expect(fns.setSheet).toHaveBeenCalledWith(expect.objectContaining({ mode: 'addRuleConfirm', pattern: 'SEDDONS EATERY' }));
});
