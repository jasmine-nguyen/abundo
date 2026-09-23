// WHIT-576 — QA gap test: "Apply my rules" re-files rows SERVER-side, so a search result that holds
// them must both show the change at once and be re-asked.
//   [A10] a rule-filed row is patched inside the search result, a vanished row is dropped from it,
//         and every ['transactionsSearch', …] query is invalidated.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';
import { AppProvider, useAppContext } from '../context';
import type { Transaction } from '../context';
import type { TransactionSearchResult } from '../api';
import { queryClient } from '../queryClient';

jest.mock('../api');
jest.mock('../auth', () => ({ getStatus: () => 'authed', subscribe: () => () => {} }));
import * as api from '../api';
const mockApi = api as jest.Mocked<typeof api>;

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;
const CAT = { id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#7fd49b', recent: 100 } as const;
const SEARCH_KEY = ['transactionsSearch', 'uncategorized', 'steven'];
const txn = (id: string): Transaction => ({
  transaction_id: id, date: '2020-01-01', authorized_date: '2020-01-01',
  description: 'STEVEN NGUYEN', merchant_name: 'Steven Nguyen', amount: -50, account_id: 'a1',
  account_name: 'ANZ', category: null, status: 'posted', type: 'PAYMENT', counts_to_budget: true,
});

beforeEach(() => {
  queryClient.clear();
  queryClient.setQueryData(['categories'], [{ ...CAT }]);
  queryClient.setQueryData<TransactionSearchResult>(SEARCH_KEY, { transactions: [txn('deep1'), txn('deep2'), txn('deep3')], truncated: false });
});
afterEach(() => { queryClient.clear(); });

it('[A10] apply-rules patches + invalidates the search result', async () => {
  mockApi.applyRulesToUncategorized.mockResolvedValue({
    dryRun: false, rulesConsidered: 1, unfiled: 3, matched: 1, conflicted: 0, conflictedSamples: [],
    byCategory: { groceries: 1 }, byRule: [], skippedRules: [],
    filed: [{ id: 'deep1', category: 'groceries' }], vanished: ['deep2'], failed: [],
  } as never);
  const result = renderHook(() => useAppContext(), { wrapper }).result;
  const spy = jest.spyOn(queryClient, 'invalidateQueries');

  await act(async () => { await result.current.applyRulesToHistory(); });

  const rows = queryClient.getQueryData<TransactionSearchResult>(SEARCH_KEY)!.transactions;
  expect(rows.map((t) => [t.transaction_id, t.category])).toEqual([['deep1', 'groceries'], ['deep3', null]]);
  const invalidated = spy.mock.calls.map((call) => (call[0] as { queryKey: string[] }).queryKey[0]);
  expect(invalidated).toContain('transactionsSearch');
  expect(queryClient.getQueryState(SEARCH_KEY)?.isInvalidated).toBe(true);
  spy.mockRestore();
});
