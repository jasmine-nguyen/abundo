// WHIT-517 — the "File by shop" button on the Uncategorized tab.
//
// It sits beside "Apply my rules" but has an EXTRA gate: it only shows when there is at least one
// rule-able shop (merchants.groups). "Apply my rules" files what existing rules cover; "File by
// shop" handles the shops with NO rule yet — so once every shop is filed it must hide, even while
// stray one-off charges keep the count above zero. It shares the other gates (uncategorized tab,
// whole-history count > 0, not selection mode, not the cold spinner / error state).
// The screen and its data code are real, over the pretend server (WHIT-686).
import { it, expect, jest, beforeEach, describe } from '@jest/globals';
import { screen, fireEvent } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const mockSetSheet = jest.fn();
let mockSheet: { mode: string } | null = null;
jest.mock('../context', () => require('./support/contextMock').realContextWith(
  () => ({ openMultiPicker: jest.fn(), showToast: jest.fn(), openPicker: jest.fn(), setSheet: mockSetSheet, sheet: mockSheet }),
));
jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import Transactions from '../../app/(tabs)/transactions';
import { resetAuth } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { GROCERIES_TOP } from './support/categories';
import { useTestQueryClient, renderWithQueries, WithQueries, settle } from './support/renderWithQueries';
import { colesTxn } from './factory';
import { styleOf, textOf } from './support/layout';

const server = installFakeServer();
useTestQueryClient();

const UNCATEGORIZED_FEED = '/transactions/uncategorized/feed';
const COUNT = '/transactions/uncategorized/count';
const MERCHANTS = '/transactions/uncategorized/merchants';
const unfiled = (id: string) => colesTxn({ transaction_id: id });

const merchants = (over: Record<string, unknown> = {}) => ({
  unfiled: 20,
  groups: [{ merchant: 'Coles', rulePattern: 'coles', groupedBy: 'merchant', count: 20, samples: ['COLES 1'], firstDate: null, lastDate: null, alsoCatches: [] }],
  ungrouped: { count: 0, samples: [] },
  ...over,
});

const BUTTON = 'transactions-file-by-shop';
const APPLY_RULES = 'transactions-apply-rules';

const seedUncategorizedFeed = (transactions: unknown[]) => server.seed(UNCATEGORIZED_FEED, { transactions, nextCursor: null });

async function renderTab(tab: 'all' | 'uncategorized' = 'uncategorized') {
  const view = await renderWithQueries(<Transactions />);
  if (tab === 'all') return view;
  fireEvent.press(screen.getByTestId('tab-uncategorized'));
  await settle();
  return view;
}

beforeEach(async () => {
  resetAuth();
  mockSetSheet.mockClear();
  mockSheet = null;
  await AsyncStorage.clear();
  server.seed('/categories', [GROCERIES_TOP]);
  server.seed(COUNT, { count: 5 });
  server.seed(MERCHANTS, merchants());
  seedUncategorizedFeed([unfiled('t1')]);
});

describe('the "File by shop" button', () => {
  it('shows on the Uncategorized tab when there are rule-able shops', async () => {
    await renderTab();
    expect(screen.getByTestId(BUTTON)).toBeTruthy();
  });

  it('opens the file-by-shop list sheet when pressed', async () => {
    await renderTab();
    fireEvent.press(screen.getByTestId(BUTTON));
    expect(mockSetSheet).toHaveBeenCalledWith({ mode: 'fileByShopList' });
  });

  // The extra gate this button adds over "Apply my rules". Fail-on-revert: drop the
  // `merchants?.groups.length > 0` clause and the button shows with an empty shop list — opening a
  // sheet with nothing to pick. Every shop filed but a stray one-off keeps the count > 0.
  it('is hidden when there are no rule-able shops, even with unfiled charges left', async () => {
    server.seed(MERCHANTS, merchants({ groups: [], unfiled: 1, ungrouped: { count: 1, samples: ['ONE OFF'] } }));
    server.seed(COUNT, { count: 1 });
    await renderTab();
    expect(screen.getByTestId(APPLY_RULES)).toBeTruthy(); // the other gates are open
    expect(screen.queryByTestId(BUTTON)).toBeNull();
  });
});

// WHIT-846: "File by shop" is the one filled button, "Apply my rules" a quiet text link under it,
// and the hint goes away once the user reaches a category pick's confirm step, remembered on the
// phone (so it stays gone when the screen is drawn again).
const HINT = /Tap a transaction to categorise it/;

it('leads with File by shop, keeps Apply my rules as a link, and hides the hint after the first category pick', async () => {
  const view = await renderTab();
  const applyRules = styleOf(screen.getByTestId(APPLY_RULES));
  expect(styleOf(screen.getByTestId(BUTTON)).backgroundColor).toBeTruthy();
  expect(applyRules.backgroundColor).toBeFalsy();
  expect(applyRules.borderWidth ?? 0).toBe(0);
  expect(applyRules.minHeight).toBeGreaterThanOrEqual(44);
  const text = textOf(screen.root);
  expect(text.indexOf('File by shop')).toBeLessThan(text.indexOf('Apply my rules'));
  expect(screen.getByText(HINT)).toBeTruthy();

  mockSheet = { mode: 'confirm' };
  view.rerender(<WithQueries><Transactions /></WithQueries>);
  await settle();
  expect(screen.queryByText(HINT)).toBeNull();

  view.unmount();
  mockSheet = null;
  await renderTab();
  expect(screen.getByTestId(BUTTON)).toBeTruthy();
  expect(screen.queryByText(HINT)).toBeNull();
});

// [A1] Every confirm step counts as the first filing (one charge, a selection, File by shop); a
// picker or list that's opened and maybe cancelled doesn't.
it.each([
  { mode: 'confirmMany', hintShown: false },
  { mode: 'fileByShopConfirm', hintShown: false },
  { mode: 'picker', hintShown: true },
  { mode: 'pickerMany', hintShown: true },
  { mode: 'fileByShopList', hintShown: true },
  { mode: 'applyRules', hintShown: true },
])('a $mode sheet leaves the hint shown: $hintShown', async ({ mode, hintShown }) => {
  const view = await renderTab();
  expect(screen.getByText(HINT)).toBeTruthy();
  mockSheet = { mode };
  view.rerender(<WithQueries><Transactions /></WithQueries>);
  await settle();
  expect(screen.queryByText(HINT) !== null).toBe(hintShown);
});
