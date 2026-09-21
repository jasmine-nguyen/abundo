// WHIT-517 — the "File by shop" button on the Uncategorized tab.
//
// It sits beside "Apply my rules" but has an EXTRA gate: it only shows when there is at least one
// rule-able shop (merchants.groups). "Apply my rules" files what existing rules cover; "File by
// shop" handles the shops with NO rule yet — so once every shop is filed it must hide, even while
// stray one-off charges keep the count above zero. It shares the other gates (uncategorized tab,
// whole-history count > 0, not selection mode, not the cold spinner / error state).
import { it, expect, jest, beforeEach, describe } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';

let mockTx: Record<string, unknown>;
let mockServerCount: number | undefined;
let mockMerchants: unknown;
jest.mock('../queries', () => ({
  useTransactionsScreenData: () => mockTx,
  useUncategorizedCount: () => mockServerCount,
  useUncategorizedMerchants: () => ({ merchants: mockMerchants, isLoading: false, isError: false }),
}));

const mockSetSheet = jest.fn();
const CAT = { id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#7FD49B', recent: 0 };
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return {
    ...actual,
    useAppContext: () => ({ openMultiPicker: jest.fn(), showToast: jest.fn(), openPicker: jest.fn(), setSheet: mockSetSheet }),
  };
});
jest.mock('expo-router', () => {
  const ReactLib = require('react');
  return { useFocusEffect: (cb: () => void) => ReactLib.useEffect(() => cb(), [cb]), useRouter: () => ({ push: jest.fn() }) };
});

import Transactions from '../../app/(tabs)/transactions';

const category = (id: string | null) => (id === 'groceries' ? CAT : undefined);
const unfiled = (id: string) => ({
  transaction_id: id, date: '2026-07-01', authorized_date: '2026-07-01', description: 'COLES',
  merchant_name: 'Coles', amount: -12.5, account_id: 'a1', account_name: 'ANZ', category: null,
  status: 'posted', type: 'PAYMENT', counts_to_budget: true,
});

function txData(over: Record<string, unknown> = {}) {
  return {
    transactions: [unfiled('t1')], category, balances: new Map(),
    isLoading: false, isError: false, isFetching: false, refetch: jest.fn(), refetchStale: jest.fn(),
    refetchList: jest.fn(() => Promise.resolve()), refreshLiveBalances: jest.fn(() => Promise.resolve()),
    hasMore: false, loadMore: jest.fn(), isLoadingMore: false, ...over,
  };
}

const merchants = (over: Record<string, unknown> = {}) => ({
  unfiled: 20,
  groups: [{ merchant: 'Coles', rulePattern: 'coles', groupedBy: 'merchant', count: 20, samples: ['COLES 1'], firstDate: null, lastDate: null, alsoCatches: [] }],
  ungrouped: { count: 0, samples: [] },
  ...over,
});

const BUTTON = 'transactions-file-by-shop';

function renderTab(tab: 'all' | 'uncategorized' = 'uncategorized') {
  render(<Transactions />);
  if (tab === 'uncategorized') fireEvent.press(screen.getByTestId('tab-uncategorized'));
}

beforeEach(() => { mockTx = txData(); mockServerCount = 5; mockMerchants = merchants(); mockSetSheet.mockClear(); });

describe('the "File by shop" button', () => {
  it('shows on the Uncategorized tab when there are rule-able shops', () => {
    renderTab();
    expect(screen.getByTestId(BUTTON)).toBeTruthy();
  });

  it('opens the file-by-shop list sheet when pressed', () => {
    renderTab();
    fireEvent.press(screen.getByTestId(BUTTON));
    expect(mockSetSheet).toHaveBeenCalledWith({ mode: 'fileByShopList' });
  });

  // The extra gate this button adds over "Apply my rules". Fail-on-revert: drop the
  // `merchants?.groups.length > 0` clause and the button shows with an empty shop list — opening a
  // sheet with nothing to pick. Every shop filed but a stray one-off keeps the count > 0.
  it('is hidden when there are no rule-able shops, even with unfiled charges left', () => {
    mockMerchants = merchants({ groups: [], unfiled: 1, ungrouped: { count: 1, samples: ['ONE OFF'] } });
    mockServerCount = 1;
    renderTab();
    expect(screen.queryByTestId(BUTTON)).toBeNull();
  });

  // While the shops are still loading (or pre-auth) the hook is undefined — the button waits rather
  // than flashing in and out.
  it('is hidden while the shop list is still loading (merchants undefined)', () => {
    mockMerchants = undefined;
    renderTab();
    expect(screen.queryByTestId(BUTTON)).toBeNull();
  });

  it('is not on the All tab', () => {
    renderTab('all');
    expect(screen.queryByTestId(BUTTON)).toBeNull();
  });

  it('is gone once the server count resolves to zero', () => {
    mockServerCount = 0;
    mockTx = txData({ transactions: [] });
    renderTab();
    expect(screen.queryByTestId(BUTTON)).toBeNull();
  });

  it('is hidden during the cold load', () => {
    mockTx = txData({ transactions: [], isLoading: true });
    renderTab();
    expect(screen.queryByTestId(BUTTON)).toBeNull();
  });

  it('is hidden while the list is in its error state', () => {
    mockTx = txData({ transactions: [], isError: true });
    renderTab();
    expect(screen.queryByTestId(BUTTON)).toBeNull();
  });

  it('is hidden in selection mode', () => {
    renderTab();
    fireEvent.press(screen.getByText('Select'));
    expect(screen.queryByTestId(BUTTON)).toBeNull();
  });
});
