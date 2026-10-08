// WHIT-517 — the "File by shop" button on the Uncategorized tab.
//
// It sits beside "Apply my rules" but has an EXTRA gate: it only shows when there is at least one
// rule-able shop (merchants.groups). "Apply my rules" files what existing rules cover; "File by
// shop" handles the shops with NO rule yet — so once every shop is filed it must hide, even while
// stray one-off charges keep the count above zero. It shares the other gates (uncategorized tab,
// whole-history count > 0, not selection mode, not the cold spinner / error state).
// The screen and its data code are real, over the pretend server (WHIT-686).
import { it, expect, jest, beforeEach, describe } from '@jest/globals';
import { render, screen, fireEvent } from '@testing-library/react-native';

const mockSetSheet = jest.fn();
jest.mock('../context', () => require('./support/contextMock').realContextWith(
  () => ({ openMultiPicker: jest.fn(), showToast: jest.fn(), openPicker: jest.fn(), setSheet: mockSetSheet }),
));
jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import Transactions from '../../app/(tabs)/transactions';
import { resetAuth } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { GROCERIES_TOP } from './support/categories';
import { useTestQueryClient, renderWithQueries, WithQueries, settle } from './support/renderWithQueries';
import { colesTxn } from './factory';

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
  await renderWithQueries(<Transactions />);
  if (tab === 'all') return;
  fireEvent.press(screen.getByTestId('tab-uncategorized'));
  await settle();
}

beforeEach(() => {
  resetAuth();
  mockSetSheet.mockClear();
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

  // While the shops are still loading the hook is undefined — the button waits rather than
  // flashing in and out.
  it('is hidden while the shop list is still loading', async () => {
    const held = server.hold(MERCHANTS);
    render(<WithQueries><Transactions /></WithQueries>);
    fireEvent.press(screen.getByTestId('tab-uncategorized'));
    expect(await screen.findByTestId(APPLY_RULES)).toBeTruthy();
    expect(screen.queryByTestId(BUTTON)).toBeNull();
    held.release();
    await settle();
  });

  it('is not on the All tab', async () => {
    await renderTab('all');
    expect(screen.getByText('5')).toBeTruthy(); // the count has resolved
    expect(screen.queryByTestId(BUTTON)).toBeNull();
  });

  it('is gone once the server count resolves to zero', async () => {
    server.seed(COUNT, { count: 0 });
    seedUncategorizedFeed([]);
    await renderTab();
    expect(screen.getByText('All caught up')).toBeTruthy();
    expect(screen.queryByTestId(BUTTON)).toBeNull();
  });

  it('is hidden during the cold load', async () => {
    await renderTab('all');
    const held = server.hold(UNCATEGORIZED_FEED);
    fireEvent.press(screen.getByTestId('tab-uncategorized'));
    expect(await screen.findByTestId('transactions-loading')).toBeTruthy();
    expect(screen.queryByTestId(BUTTON)).toBeNull();
    held.release();
    await settle();
  });

  it('is hidden while the list is in its error state', async () => {
    server.fail(UNCATEGORIZED_FEED, 500);
    await renderTab();
    expect(screen.getByTestId('transactions-error')).toBeTruthy();
    expect(screen.queryByTestId(BUTTON)).toBeNull();
  });

  it('is hidden in selection mode', async () => {
    await renderTab();
    expect(screen.getByTestId(BUTTON)).toBeTruthy();
    fireEvent.press(screen.getByText('Select'));
    expect(screen.queryByTestId(BUTTON)).toBeNull();
  });
});
