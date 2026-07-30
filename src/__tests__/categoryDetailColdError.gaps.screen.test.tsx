// WHIT-367 GAP — the drill-in screen (app/category/[id].tsx) when the taxonomy FAILS to load
// while transactions are cached. categoryDetail.screen.test.tsx covers error-with-NO-cache and a
// background refetch failing over BOTH-loaded cache; the gap is: transactions cached but
// categoriesReady false + isError true. hasCache = txns>0 && categoriesReady, so this must resolve
// to the error card (+ retry), NOT a cold "$0"/grey-row detail. Same mock shape as
// categoryDetail.screen.test.tsx (../queries + ../context partial + expo-router + safe-area stubbed).
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';

let mockData: ReturnType<typeof screenData>;
let mockDetail: unknown;
jest.mock('../queries', () => ({ useCategoryTransactionsScreenData: () => mockData }));

jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return {
    ...actual,
    useAppContext: () => ({ openPicker: jest.fn(), category: () => undefined }),
    categoryTransactions: () => mockDetail,
  };
});

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: 'salary', cycle: '0' }),
  useRouter: () => ({ back: jest.fn(), push: jest.fn() }),
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

import CategoryDetail from '../../app/category/[id]';

const ROW = {
  transaction_id: 't1', date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'Payroll', merchant_name: 'Payroll', amount: 4200, account_id: 'a1',
  account_name: 'Everyday', category: null, status: 'posted', type: 'deposit', counts_to_budget: false,
};
const DETAIL = { id: 'salary', name: 'Salary', groups: [{ label: 'Jul 1', items: [ROW] }], count: 1, total: 4200, posted: 4200, pending: 0 };

function screenData(over: Partial<{ transactions: unknown[]; categoriesReady: boolean; isLoading: boolean; isError: boolean; refetch: () => void }> = {}) {
  return {
    transactions: [ROW], category: (_id: string | null) => undefined,
    categoriesReady: true, isLoading: false, isError: false, refetch: jest.fn(), refetchStale: jest.fn(),
    ...over,
  };
}

beforeEach(() => { mockData = screenData(); mockDetail = DETAIL; });

// WHIT-367 [A-CE1] (P0) — taxonomy read failed but transactions are cached. Because categoriesReady
// is false, hasCache is false, so the error card (which needs the taxonomy to label/sign rows)
// wins over rendering a cold detail. FAIL-ON-REVERT: dropping `&& categoriesReady` from hasCache
// makes hasCache true → showError false → the cold detail renders and this assertion fails.
it('shows the error+retry (not a cold detail) when the taxonomy fails over cached transactions', () => {
  const refetch = jest.fn();
  mockData = screenData({ transactions: [ROW], categoriesReady: false, isError: true, refetch });
  render(<CategoryDetail />);
  expect(screen.getByTestId('category-error')).toBeTruthy();
  expect(screen.queryByTestId('category-total')).toBeNull(); // no cold "$0" total card
  const retry = screen.getByTestId('category-retry');
  fireEvent.press(retry);
  expect(refetch).toHaveBeenCalledTimes(1);
});
