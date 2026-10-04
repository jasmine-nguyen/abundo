// WHIT-292 — adversarial provider-level gaps the helper unit tests + existing provider suites
// DON'T cover. persistCategoryBatch is proven in isolation (persistCategoryBatch.logic.test.ts)
// and applyCategory('all') is proven wired to it; this file locks the two writer-level edges the
// refactor could silently regress:
//   [A-M100] applyCategoryToMany actually chunks a >100 multi-select through the shared helper
//            (the logic test proves the helper chunks; nothing proved the MULTI-SELECT writer does).
//   [A-EMPTY] applyCategory('all') still fires createRule AND files the rule on an EMPTY
//             sweep — the rule must not be gated on there being charges to file (the old single
//             Promise.allSettled([createRule, ...chunks]) always issued the rule).
//   [A-DEDUPE] applyCategoryToMany's Set-dedupe still collapses duplicate ids to ONE update.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';
import { AppProvider, useAppContext } from '../context';
import type { Transaction, Category } from '../types';
import type { Rule } from '../model';
import { queryClient } from '../queryClient';
import { seedTransactionsCache, readTransactionsCache } from './support/transactionsCache';

jest.mock('../auth', () => ({ getStatus: () => 'authed', subscribe: () => () => {}, getAuthToken: async () => 'test-id-token' }));
import { installFakeServer } from './support/fakeServer';
import { GROCERIES } from './support/categories';

const server = installFakeServer();
// The `updates` of every batch save the app sent, in order.
const batches = () => server.sent('PATCH', '/transactions')
  .map((r) => (r.body as { updates: { id: string; category: string }[] }).updates);

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;

const CAT = GROCERIES;
const TXN = {
  transaction_id: 't1', date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'COLES', merchant_name: 'Coles', amount: -12.5, account_id: 'a1',
  account_name: 'ANZ', category: null, status: 'posted', type: 'PAYMENT', counts_to_budget: true,
} as const;

const txns = () => readTransactionsCache(queryClient);
const rules = () => queryClient.getQueryData<Rule[]>(['rules']) ?? [];

// The fake server's batch endpoint echoes every id back as 'updated' unless a test says otherwise.
beforeEach(() => { queryClient.clear(); });
afterEach(() => { queryClient.clear(); });

function seed(txnList: readonly Transaction[]) {
  seedTransactionsCache(queryClient, txnList.map((t) => ({ ...t })));
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

  expect(batches()).toHaveLength(2);
  const sizes = batches().map((updates) => updates.length).sort((a, b) => b - a);
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
  seedTransactionsCache(queryClient, many.map((t) => ({ ...t })));
  queryClient.setQueryData(['categories'], [
    { ...CAT } as Category,
    { id: 'dining', name: 'Dining', bucket: 'Lifestyle', icon: 'utensils', color: '#f7768e', recent: 0 } as Category,
  ]);
  queryClient.setQueryData(['budgets', 14], {});
  queryClient.setQueryData(['rules'], []);
  server.once('PATCH', '/transactions', {
    body: { results: many.slice(0, 100).map((t) => ({ id: t.transaction_id, status: 'updated' })) },
  });
  server.once('PATCH', '/transactions', { status: 500 }); // second chunk down
  const result = mount();

  await act(async () => { await result.current.applyCategoryToMany(many.map((t) => t.transaction_id), 'dining'); });

  const byId = Object.fromEntries(txns().map((t) => [t.transaction_id, t.category]));
  expect(byId.m0).toBe('dining');       // first chunk (m0..m99) saved
  expect(byId.m149).toBe('groceries');  // rejected chunk restored to PREVIOUS category, not null
  expect(txns().filter((t) => t.category === 'dining')).toHaveLength(100);
  expect(result.current.toast).toBe('Could not save some categories. Please try again.');
});

// [A-EMPTY] applyCategory('all') with an EMPTY merchant sweep still ISSUES the rule AND files the
// tapped charge — the rule is independent of the sweep, and the tapped charge is the user's
// explicit pick (WHIT-324), so it's filed even when no OTHER charge qualifies. Fail-on-revert:
// gate createRule on sameMerchantIds.length > 0, or drop the tapped charge from the set, and
// the assertions below go red.
it("applyCategory('all') files the tapped charge and mints the rule when the sweep is empty", async () => {
  server.once('POST', '/rules', { body: { id: 'e1', field: 'description', operator: 'contains', value: 'COLES', categoryId: 'groceries' } });
  // Origin doesn't count to a budget -> no OTHER charge is swept; only the tapped charge is filed.
  seed([{ ...TXN, transaction_id: 't1', category: null, counts_to_budget: false }]);
  const result = mount();

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('all'); });

  expect(batches()).toHaveLength(1);                                     // the tapped charge is filed
  expect(batches()[0]).toEqual([{ id: 't1', category: 'groceries' }]);
  expect(server.requests()).toContainEqual({ method: 'POST', path: '/rules', body: { value: 'COLES', categoryId: 'groceries' } }); // rule STILL fires
  // The optimistic rule was reconciled to the real BankSync id (not rolled back) and survives.
  expect(rules()).toHaveLength(1);
  expect(rules()[0].id).toBe('e1');
  // WHIT-324: the tapped charge counts, so the toast names the one it just filed.
  expect(result.current.toast).toBe('1 transaction filed — future COLES charges file as Groceries.');
});

// [A-DEDUPE] applyCategoryToMany collapses duplicate ids to ONE update before the helper — a
// double-tapped selection must not send the same id twice. Fail-on-revert: drop the `new Set(...)`
// dedupe and the batch would carry two {id:'t1'} rows.
it('applyCategoryToMany dedupes repeated ids to a single batch update', async () => {
  seed([{ ...TXN, transaction_id: 't1', category: null }]);
  const result = mount();

  await act(async () => { await result.current.applyCategoryToMany(['t1', 't1', 't1'], 'groceries'); });

  expect(batches()).toHaveLength(1);
  expect(batches()[0]).toEqual([{ id: 't1', category: 'groceries' }]);
});
