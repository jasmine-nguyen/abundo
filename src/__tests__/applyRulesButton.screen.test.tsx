// WHIT-508 — the "Apply my rules" button on the Uncategorized tab.
//
// It is gated on the WHOLE-history count (the number the badge shows), not the loaded-page count:
// after a capped run the loaded page can be empty while hundreds of unfiled charges remain deeper
// in history — exactly when the button is still needed. And it is hidden behind the cold spinner
// and the load-error state like every other control on this screen, so it never renders over
// "Couldn't load your transactions."
import { it, expect, jest, beforeEach, describe } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';

let mockTx: Record<string, unknown>;
let mockServerCount: number | undefined;
jest.mock('../queries', () => ({
  useTransactionsScreenData: () => mockTx,
  useUncategorizedCount: () => mockServerCount,
  useUncategorizedMerchants: () => ({ merchants: undefined, isLoading: false, isError: false }),
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

const BUTTON = 'transactions-apply-rules';

/** Render and switch to the Uncategorized tab unless told otherwise. */
function renderTab(tab: 'all' | 'uncategorized' = 'uncategorized') {
  render(<Transactions />);
  if (tab === 'uncategorized') fireEvent.press(screen.getByTestId('tab-uncategorized'));
}

beforeEach(() => { mockTx = txData(); mockServerCount = 5; mockSetSheet.mockClear(); });

describe('the "Apply my rules" button', () => {
  it('shows on the Uncategorized tab when there are unfiled charges', () => {
    renderTab();
    expect(screen.getByTestId(BUTTON)).toBeTruthy();
  });

  it('opens the apply-rules sheet when pressed', () => {
    renderTab();
    fireEvent.press(screen.getByTestId(BUTTON));
    expect(mockSetSheet).toHaveBeenCalledWith({ mode: 'applyRules' });
  });

  it('is not on the All tab', () => {
    renderTab('all');
    expect(screen.queryByTestId(BUTTON)).toBeNull();
  });

  // "All caught up" — offering a sweep with nothing to sweep is noise.
  it('is gone once the server count resolves to zero', () => {
    mockServerCount = 0;
    mockTx = txData({ transactions: [] });
    renderTab();
    expect(screen.queryByTestId(BUTTON)).toBeNull();
  });

  // The whole-history gate: the loaded page is empty (the rows sit deeper in history), but the
  // badge says 339 remain — which is exactly the state a capped run leaves behind. Fail-on-revert:
  // gate on the local loaded-page count instead and the button vanishes mid-way through the job.
  it('stays visible when the loaded page is empty but history still has unfiled charges', () => {
    mockServerCount = 339;
    mockTx = txData({ transactions: [], hasMore: true });
    renderTab();
    expect(screen.getByTestId(BUTTON)).toBeTruthy();
  });

  // Fail-on-revert for the two gates the review added: drop `!showSpinner` / `!showError` and the
  // button renders over the cold spinner or alongside "Couldn't load your transactions."
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

  // Selection mode is its own task ("re-categorise these 6"); a whole-history sweep alongside it
  // would be two competing bulk actions on one screen.
  it('is hidden in selection mode', () => {
    renderTab();
    fireEvent.press(screen.getByText('Select'));
    expect(screen.queryByTestId(BUTTON)).toBeNull();
  });
});
