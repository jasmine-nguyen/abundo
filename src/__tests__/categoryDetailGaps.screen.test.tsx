// WHIT-308 — category drill-in screen GAPS (adversarial): edges categoryDetail.screen.test.tsx
// leaves open.
//   [A-S1] header title falls back to 'Category' (not undefined/crash) while detail is null
//   [A-S2] a non-null $0 detail (both buckets refunded to 0) still renders the total card + list,
//          NOT the empty state — the count>0 path, distinct from detail===null
// Same mock shape as categoryDetail.screen.test.tsx: ../queries + ../context (partial) + expo-router
// + safe-area stubbed; categoryTransactions is stubbed so this asserts the SCREEN, not the math.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen } from '@testing-library/react-native';

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
  useLocalSearchParams: () => ({ id: 'coffee', cycle: '0' }),
  useRouter: () => ({ back: jest.fn(), push: jest.fn() }),
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

import CategoryDetail from '../../app/category/[id]';

const ROW = {
  transaction_id: 't1', date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'ST ALi', merchant_name: 'ST Ali', amount: -8.5, account_id: 'a1',
  account_name: 'Everyday', category: null, status: 'posted', type: 'purchase', counts_to_budget: true,
};

function screenData(over: Partial<{ transactions: unknown[]; isLoading: boolean; isError: boolean; payCycleError: boolean; refetch: () => void }> = {}) {
  return {
    transactions: [ROW], category: (_id: string | null) => undefined,
    payCycle: { length: 14, last_pay_date: '2026-06-06' },
    isLoading: false, isError: false, payCycleError: false, refetch: jest.fn(), refetchStale: jest.fn(),
    ...over,
  };
}

beforeEach(() => { mockData = screenData(); });

// [A-S1] detail is null (empty cycle / stale deep-link) → the header must still read a sensible
// title. Fail-on-revert: dropping the `?? 'Category'` fallback makes the title `undefined` and
// this query fails.
it('shows the fallback header title "Category" when detail is null', () => {
  mockDetail = null;
  render(<CategoryDetail />);
  expect(screen.getByText('Category')).toBeTruthy();
});

// [A-S2] A non-null detail whose total clamped to 0 must still render the total card + list, NOT
// the empty state — the screen branches on `detail` truthiness, not on total > 0. Guards the
// logic gap [A-G2] at the screen boundary.
it('renders the $0 total card and list (not the empty state) for a non-null zero-total detail', () => {
  mockDetail = {
    id: 'coffee', name: 'Cafes & Coffee',
    groups: [{ label: 'Jul 1', items: [ROW] }],
    count: 2, total: 0, posted: 0, pending: 0,
  };
  render(<CategoryDetail />);
  expect(screen.getByTestId('category-total')).toBeTruthy();
  expect(screen.getByText('$0')).toBeTruthy();
  expect(screen.getByText('ST Ali')).toBeTruthy();       // the list still renders
  expect(screen.queryByText('No transactions')).toBeNull();
});
