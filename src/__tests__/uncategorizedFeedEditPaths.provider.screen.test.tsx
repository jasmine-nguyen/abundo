// WHIT-500 gaps — the OTHER two optimistic write paths (besides applyCategory('one'), locked by
// uncategorizedFeedResolveAndPatch.provider.screen.test.tsx) that must also reach a row living
// ONLY in the paged Uncategorized feed cache, because they all funnel through
// patchTransactionsCache — which the fix taught to map over the ['uncategorizedFeed'] pages:
//   [C5] applyTransactionEdit (a note / tag / transfer-exclude edit) — a deep-history unfiled row
//        the user edits from the detail screen must update IN the uncategorized feed cache.
//   [C6] applyCategoryToMany (multi-select batch file) — filing a batch that includes uncat-feed
//        rows must patch their category there, so the tab's re-filter drops them instantly.
// These are DISTINCT call paths from the single-file test: a regression that routed either through
// a ['transactions']-only patch would pass that test but be caught here.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';
import { AppProvider, useAppContext } from '../context';
import type { Transaction } from '../context';
import { queryClient } from '../queryClient';

jest.mock('../api');
jest.mock('../auth', () => ({ getStatus: () => 'authed', subscribe: () => () => {} }));
import * as api from '../api';
const mockApi = api as jest.Mocked<typeof api>;

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;

const CAT = { id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#7fd49b', recent: 100 } as const;
const txn = (over: Partial<Transaction> = {}): Transaction => ({
  transaction_id: 't1', date: '2020-01-01', authorized_date: '2020-01-01',
  description: 'COLES', merchant_name: 'Coles', amount: -12.5, account_id: 'a1',
  account_name: 'ANZ', category: null, status: 'posted', type: 'PAYMENT', counts_to_budget: true, ...over,
});

function seedUncategorizedFeed(transactions: Partial<Transaction>[]) {
  queryClient.setQueryData(['uncategorizedFeed'], { pages: [{ transactions, nextCursor: null }], pageParams: [undefined] });
}
function readUncategorizedFeed(): Transaction[] {
  const data = queryClient.getQueryData<{ pages: { transactions: Transaction[] }[] }>(['uncategorizedFeed']);
  return data ? data.pages.flatMap((p) => p.transactions) : [];
}

beforeEach(() => {
  queryClient.clear();
  mockApi.setTransactionFields.mockResolvedValue({ transaction_id: 'deep1' } as never);
  mockApi.setTransactionCategories.mockResolvedValue({ results: [{ id: 'm1', status: 'updated' }, { id: 'm2', status: 'updated' }] } as never);
  queryClient.setQueryData(['categories'], [{ ...CAT }]);
  queryClient.setQueryData(['budgets', 14], {});
});
afterEach(() => { queryClient.clear(); });

function mount() {
  return renderHook(() => useAppContext(), { wrapper }).result;
}

// [C5] a note edit on a row present ONLY in the uncategorized feed cache reflects there.
// Fail-on-revert: drop the ['uncategorizedFeed'] arm from patchTransactionsCache -> notes never lands.
it('applyTransactionEdit updates a note on a row that lives only in the uncategorized feed', async () => {
  seedUncategorizedFeed([txn({ transaction_id: 'deep1', notes: undefined })]);
  const result = mount();

  await act(async () => { await result.current.applyTransactionEdit('deep1', { notes: 'holiday' }); });

  const row = readUncategorizedFeed().find((t) => t.transaction_id === 'deep1');
  expect(row?.notes).toBe('holiday');                    // the optimistic edit reached the uncat feed cache
  expect(mockApi.setTransactionFields).toHaveBeenCalledWith('deep1', { notes: 'holiday' });
});

// [C6] a multi-select batch file that includes uncat-feed rows patches their category there, so the
// tab's client re-filter (isUncategorized) drops them from the list at once.
it('applyCategoryToMany files uncategorized-feed rows in place (category set in the feed cache)', async () => {
  seedUncategorizedFeed([txn({ transaction_id: 'm1', category: null }), txn({ transaction_id: 'm2', category: null })]);
  const result = mount();

  await act(async () => { await result.current.applyCategoryToMany(['m1', 'm2'], 'groceries'); });

  const cats = readUncategorizedFeed().map((t) => t.category);
  expect(cats).toEqual(['groceries', 'groceries']);      // both filed IN the uncat feed cache
});
