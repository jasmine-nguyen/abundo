// WHIT-292 — adversarial provider-level gaps the helper unit tests + existing provider suites
// DON'T cover. persistCategoryBatch is proven in isolation (persistCategoryBatch.logic.test.ts)
// and applyCategory('all') is proven wired to it; this file locks the two writer-level edges the
// refactor could silently regress:
//   [A-M100] applyCategoryToMany actually chunks a >100 multi-select through the shared helper
//            (the logic test proves the helper chunks; nothing proved the MULTI-SELECT writer does).
//   [A-EMPTY] applyCategory('all') still fires createEnrichment AND files the rule on an EMPTY
//             sweep — the rule must not be gated on there being charges to file (the old single
//             Promise.allSettled([createEnrichment, ...chunks]) always issued the rule).
//   [A-DEDUPE] applyCategoryToMany's Set-dedupe still collapses duplicate ids to ONE update.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';
import { AppProvider, useAppContext } from '../context';
import type { Transaction, Category, Rule } from '../context';
import { queryClient } from '../queryClient';

jest.mock('../api');
jest.mock('../auth', () => ({ getStatus: () => 'authed', subscribe: () => () => {} }));
import * as api from '../api';
const mockApi = api as jest.Mocked<typeof api>;

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;

const CAT = { id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#7fd49b', recent: 100 } as const;
const TXN = {
  transaction_id: 't1', date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'COLES', merchant_name: 'Coles', amount: -12.5, account_id: 'a1',
  account_name: 'ANZ', category: null, status: 'posted', type: 'PAYMENT', counts_to_budget: true,
} as const;

const txns = () => queryClient.getQueryData<Transaction[]>(['transactions']) ?? [];
const rules = () => queryClient.getQueryData<Rule[]>(['rules']) ?? [];

beforeEach(() => {
  queryClient.clear();
  // Default: the batch endpoint echoes every id back as 'updated'.
  mockApi.setTransactionCategories.mockImplementation(
    async (updates: { id: string; category: string }[]) =>
      ({ results: updates.map((u) => ({ id: u.id, status: 'updated' as const })) }));
});
afterEach(() => { queryClient.clear(); });

function seed(txnList: readonly Transaction[]) {
  queryClient.setQueryData(['transactions'], txnList.map((t) => ({ ...t })));
  queryClient.setQueryData(['categories'], [{ ...CAT } as Category]);
  queryClient.setQueryData(['budgets', 14], {});
  queryClient.setQueryData(['payCycle'], { length: 14, last_pay_date: '2024-01-03' });
  queryClient.setQueryData(['rules'], []);
}

function mount() {
  const { result } = renderHook(() => useAppContext(), { wrapper });
  return result;
}

// [A-M100] applyCategoryToMany chunks a >100 multi-select into 100+50 through persistCategoryBatch.
// Fail-on-revert: raise CATEGORY_BATCH_LIMIT above 150 (no split) -> this expects 2 calls, gets 1.
it('applyCategoryToMany splits a >100 multi-select into chunks of 100 (shared helper wiring)', async () => {
  const many = Array.from({ length: 150 }, (_, i) => ({ ...TXN, transaction_id: `m${i}`, category: null }));
  seed(many);
  const result = mount();

  await act(async () => { await result.current.applyCategoryToMany(many.map((t) => t.transaction_id), 'groceries'); });

  expect(mockApi.setTransactionCategories).toHaveBeenCalledTimes(2);
  const sizes = mockApi.setTransactionCategories.mock.calls.map((c) => c[0].length).sort((a, b) => b - a);
  expect(sizes).toEqual([100, 50]);
  // Both chunks succeed (default echo) -> all 150 filed under groceries.
  expect(txns().filter((t) => t.category === 'groceries')).toHaveLength(150);
});

// [A-M100b] A rejected chunk in a >100 multi-select reverts EXACTLY that chunk's ids to their
// PREVIOUS category (not a blanket null — the 'all' path nulls, the multi-select restores).
// Fail-on-revert: swap previousById.get(...) ?? null for a bare null in applyCategoryToMany and
// the survivors would come back null instead of 'groceries' below.
it('applyCategoryToMany reverts only the rejected chunk to its previous category (>100, partial)', async () => {
  // Every charge starts filed under groceries; we re-file to dining. First chunk saves, second rejects.
  queryClient.clear();
  const many = Array.from({ length: 150 }, (_, i) => ({ ...TXN, transaction_id: `m${i}`, category: 'groceries' }));
  queryClient.setQueryData(['transactions'], many.map((t) => ({ ...t })));
  queryClient.setQueryData(['categories'], [
    { ...CAT } as Category,
    { id: 'dining', name: 'Dining', bucket: 'Lifestyle', icon: 'utensils', color: '#f7768e', recent: 0 } as Category,
  ]);
  queryClient.setQueryData(['budgets', 14], {});
  queryClient.setQueryData(['rules'], []);
  mockApi.setTransactionCategories.mockImplementation(async (updates: { id: string; category: string }[]) => {
    if (updates.length !== 100) throw new Error('second chunk down');
    return { results: updates.map((u) => ({ id: u.id, status: 'updated' as const })) };
  });
  const result = mount();

  await act(async () => { await result.current.applyCategoryToMany(many.map((t) => t.transaction_id), 'dining'); });

  const byId = Object.fromEntries(txns().map((t) => [t.transaction_id, t.category]));
  expect(byId.m0).toBe('dining');       // first chunk (m0..m99) saved
  expect(byId.m149).toBe('groceries');  // rejected chunk restored to PREVIOUS category, not null
  expect(txns().filter((t) => t.category === 'dining')).toHaveLength(100);
  expect(result.current.toast).toBe('Could not save some categories. Please try again.');
});

// [A-EMPTY] applyCategory('all') on an EMPTY sweep still ISSUES the rule and files it — the rule
// is independent of whether any current charge was swept. Existing 'does NOT call the batch when
// the sweep is empty' proves the batch is skipped; nothing proved the rule still fires. Fail-on-
// revert: gate createEnrichment on sameMerchantIds.length > 0 and both assertions below go red.
it("applyCategory('all') still creates the rule when the sweep is empty (no batch, rule filed)", async () => {
  mockApi.createEnrichment.mockResolvedValue({ id: 'e1', field: 'description', operator: 'contains', value: 'COLES', categoryId: 'groceries' });
  // Origin doesn't count to a budget -> sameMerchantIds is empty -> no charge to file.
  seed([{ ...TXN, transaction_id: 't1', category: null, counts_to_budget: false }]);
  const result = mount();

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('all'); });

  expect(mockApi.setTransactionCategories).not.toHaveBeenCalled();          // empty sweep -> no batch call
  expect(mockApi.createEnrichment).toHaveBeenCalledWith({ value: 'COLES', categoryId: 'groceries' }); // rule STILL fires
  // The optimistic rule was reconciled to the real BankSync id (not rolled back) and survives.
  expect(rules()).toHaveLength(1);
  expect(rules()[0].id).toBe('e1');
  // WHIT-292: an empty sweep shows the rule-only toast (no count) — it must NOT claim charges
  // filed when none did. A non-empty sweep names the count (see appProvider happy-path test).
  expect(result.current.toast).toBe('Rule saved — future COLES charges file as Groceries.');
});

// [A-DEDUPE] applyCategoryToMany collapses duplicate ids to ONE update before the helper — a
// double-tapped selection must not send the same id twice. Fail-on-revert: drop the `new Set(...)`
// dedupe and the batch would carry two {id:'t1'} rows.
it('applyCategoryToMany dedupes repeated ids to a single batch update', async () => {
  seed([{ ...TXN, transaction_id: 't1', category: null }]);
  const result = mount();

  await act(async () => { await result.current.applyCategoryToMany(['t1', 't1', 't1'], 'groceries'); });

  expect(mockApi.setTransactionCategories).toHaveBeenCalledTimes(1);
  expect(mockApi.setTransactionCategories.mock.calls[0][0]).toEqual([{ id: 't1', category: 'groceries' }]);
});
