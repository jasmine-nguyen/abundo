// WHIT-501 GAP — the implementer's uncategorizedCountInvalidation test covers applyCategory('one'),
// applyCategoryToMany, deleteCategory and the applyTransactionEdit guard. It does NOT cover
// applyCategory('all') — the "file every {merchant} charge + mint a rule" sweep. That path files a
// batch of charges from a SEPARATE invalidateAfterCategorise() call site (context.tsx, inside the
// `scope === 'all'` branch), so a revert THERE is invisible to the 'one' test. This locks it.
//
// Fail-on-revert: delete the invalidateAfterCategorise() call at the end of the scope==='all' branch
// (or drop the ['uncategorizedCount'] line from invalidateAfterCategorise) → [A-inval-all] fails.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';
import { AppProvider, useAppContext } from '../context';
import type { Transaction } from '../types';
import { queryClient } from '../queryClient';
import { seedTransactionsCache } from './support/transactionsCache';

jest.mock('../auth', () => ({ getStatus: () => 'authed', subscribe: () => () => {}, getAuthToken: async () => 'test-id-token' }));
import { installFakeServer } from './support/fakeServer';
import { GROCERIES } from './support/categories';
import { invalidatedKeys } from './support/queryClient';

const server = installFakeServer();

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;

const CAT = GROCERIES;
const txn = (over: Partial<Transaction> = {}): Transaction => ({
  transaction_id: 't1', date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'COLES 0412 SYDNEY', merchant_name: 'Coles', amount: -12.5, account_id: 'a1',
  account_name: 'ANZ', category: null, status: 'posted', type: 'PAYMENT', counts_to_budget: true,
  ...over,
});

beforeEach(() => {
  queryClient.clear();
  // the fake server's batch endpoint reports every id updated; the rule mint answers a well-formed rule.
});
afterEach(() => { queryClient.clear(); });

function mount(transactions: Transaction[]) {
  seedTransactionsCache(queryClient, transactions);
  queryClient.setQueryData(['categories'], [{ ...CAT }]);
  queryClient.setQueryData(['rules'], []);
  queryClient.setQueryData(['budgets', 14], {});
  const { result } = renderHook(() => useAppContext(), { wrapper });
  return result;
}

// [A-inval-all] the merchant-sweep re-file lowers the whole-history tally → the badge/dot/empty
// state must refetch. Two same-merchant uncategorized charges; file "every COLES charge".
it('applyCategory("all") invalidates uncategorizedCount from its own call site', async () => {
  const result = mount([txn(), txn({ transaction_id: 't2', description: 'COLES 0999 MELBOURNE' })]);
  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  const spy = jest.spyOn(queryClient, 'invalidateQueries');

  await act(async () => { await result.current.applyCategory('all'); });

  expect(invalidatedKeys(spy)).toContain('uncategorizedCount');
  spy.mockRestore();
});

// [A-inval-all-allfail] if EVERY save in the sweep fails, nothing actually got re-filed, so the tally
// can't have moved — the count must NOT be invalidated (`failedIds.length < sameMerchantIds.length`
// guards it). Locks that the invalidate is gated on a real change, not fired unconditionally.
it('applyCategory("all") does NOT invalidate uncategorizedCount when every save fails', async () => {
  server.once('PATCH', '/transactions', { body: { results: [{ id: 't1', status: 'error' }] } });
  const result = mount([txn()]);
  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  const spy = jest.spyOn(queryClient, 'invalidateQueries');

  await act(async () => { await result.current.applyCategory('all'); });

  expect(invalidatedKeys(spy)).not.toContain('uncategorizedCount');
  spy.mockRestore();
});
