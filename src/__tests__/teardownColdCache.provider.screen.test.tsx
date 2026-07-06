// WHIT-192 GAPS — the teardown's NEW failure mode: a writer runs while the query cache the
// eager store used to guarantee is COLD (never loaded / evicted). Complements
// storeReaderWrites / appProvider / transactionsCategorize / rulesWrite(Gaps) / loanFactsWrite,
// which all SEED a warm cache. Here every writer sources its reads from a cold cache and must
// bail or no-op gracefully — never corrupt the cache or fire a defaulted server write. Drives
// the REAL writers via AppProvider + the singleton queryClient (../api + ../auth mocked).
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';
import { AppProvider, useAppContext } from '../context';
import type { Category, Transaction, Rule } from '../context';
import type { BudgetRollup } from '../api';
import { queryClient } from '../queryClient';

jest.mock('../api');
jest.mock('../auth', () => ({ getStatus: () => 'authed', subscribe: () => () => {} }));
import * as api from '../api';
const mockApi = api as jest.Mocked<typeof api>;

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;

const CAT: Category = { id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#7fd49b', recent: 0 };
const txn = (over: Partial<Transaction> = {}): Transaction => ({
  transaction_id: 't1', date: '2026-07-01', authorized_date: '2026-07-01', description: 'COLES',
  merchant_name: 'Coles', amount: -12.5, account_id: 'a1', account_name: 'ANZ', category: null,
  status: 'posted', type: 'PAYMENT', counts_to_budget: true, ...over,
});

beforeEach(() => { queryClient.clear(); });
afterEach(() => { queryClient.clear(); });

function mount() {
  const { result } = renderHook(() => useAppContext(), { wrapper });
  return result;
}

// --- persistPayCycle: cold ['payCycle'] cache must BAIL, not persist a defaulted cycle ------

it('setPayCycleLength bails on a cold [payCycle] cache — no server write, no corrupt cache', async () => {
  // The pay-cycle sheet warms ['payCycle'] on open; if a change fires before that resolved,
  // persisting mutate({length}) over an undefined prev would drop the sibling last_pay_date.
  mockApi.setPayCycle.mockResolvedValue({ length: 30, last_pay_date: '2024-01-03' });
  const result = mount(); // NO ['payCycle'] seed

  await act(async () => { result.current.setPayCycleLength(30); });

  expect(mockApi.setPayCycle).not.toHaveBeenCalled();            // <-- fails on revert of the !prev guard
  expect(queryClient.getQueryData(['payCycle'])).toBeUndefined(); // no half-built cycle written
});

it('setPayday bails on a cold [payCycle] cache too (same guard, other field)', async () => {
  mockApi.setPayCycle.mockResolvedValue({ length: 14, last_pay_date: '2026-07-01' });
  const result = mount();

  await act(async () => { result.current.setPayday('2026-07-01'); });

  expect(mockApi.setPayCycle).not.toHaveBeenCalled();
  expect(queryClient.getQueryData(['payCycle'])).toBeUndefined();
});

// --- applyCategory: cold ['transactions']/['categories'] must no-op (close the sheet) --------

it('applyCategory(one) no-ops on a cold transactions/categories cache — closes the sheet, no PATCH', async () => {
  mockApi.setTransactionCategory.mockResolvedValue({ transaction_id: 't1', category: 'groceries' });
  const result = mount(); // NO transactions/categories seed
  act(() => { result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }); });

  await act(async () => { await result.current.applyCategory('one'); });

  expect(mockApi.setTransactionCategory).not.toHaveBeenCalled(); // nothing to categorise
  expect(result.current.sheet).toBeNull();                       // sheet closed, not stuck open
});

it('applyCategory(all) no-ops on a cold cache — mints no rule, sends no batch', async () => {
  const result = mount();
  act(() => { result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }); });

  await act(async () => { await result.current.applyCategory('all'); });

  expect(mockApi.createEnrichment).not.toHaveBeenCalled();
  expect(mockApi.setTransactionCategories).not.toHaveBeenCalled();
  expect(result.current.sheet).toBeNull();
});

it('applyCategory no-ops when transactions are warm but the taxonomy is cold (partial cold)', async () => {
  // The tx exists, but the chosen category can't be resolved (['categories'] never loaded) →
  // the category lookup fails and the write must bail rather than file under an unknown id.
  queryClient.setQueryData(['transactions'], [txn({ transaction_id: 't1' })]);
  mockApi.setTransactionCategory.mockResolvedValue({ transaction_id: 't1', category: 'groceries' });
  const result = mount();
  act(() => { result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }); });

  await act(async () => { await result.current.applyCategory('one'); });

  expect(mockApi.setTransactionCategory).not.toHaveBeenCalled();
  expect(result.current.sheet).toBeNull();
});

// --- saveBudget: cold-cache toast lookups must degrade gracefully, not crash ------------------

it('saveBudget still saves on a cold [categories] cache — returns true, no crash, no success toast', async () => {
  // The toast copy needs the category name from ['categories']; cold → no name → the write
  // still persists (the Budgets screen invalidates + reconciles), it just shows no toast.
  mockApi.setBudget.mockResolvedValue({ id: 'groceries', target: 300 });
  const result = mount(); // NO categories/budgets seed

  let ok: boolean | undefined;
  await act(async () => { ok = await result.current.saveBudget('groceries', 300); });

  expect(ok).toBe(true);
  expect(mockApi.setBudget).toHaveBeenCalledWith('groceries', 300);
  expect(result.current.toast).toBeNull(); // no category name → no success toast (no thrown lookup)
});

it('saveBudget "updated" copy scans EVERY budget window, not just the current one', async () => {
  // WHIT-192 replaced budgets.find (single current window) with getQueriesData over ['budgets',*].
  // A budget living in a NON-current window (30) must still read as an EDIT, not a fresh SET —
  // and the cache is the RAW Record<categoryId, BudgetRollup>, not a Budget[] array.
  mockApi.setBudget.mockResolvedValue({ id: 'groceries', target: 300 });
  queryClient.setQueryData<Category[]>(['categories'], [CAT]);
  queryClient.setQueryData<Record<string, BudgetRollup>>(['budgets', 30], { groceries: { target: 100, posted: 0, pending: 0 } });
  // Current-window (14) cache is empty — a plain single-window lookup would say "set".
  queryClient.setQueryData<Record<string, BudgetRollup>>(['budgets', 14], {});
  const result = mount();

  await act(async () => { await result.current.saveBudget('groceries', 300); });

  expect(result.current.toast).toBe('Groceries budget updated to $300.'); // updated (found in the 30 window)
});

// --- saveManualRule: cold [categories] toast lookup is graceful; rule still lands -------------

it('saveManualRule writes the rule but shows no toast when [categories] is cold', async () => {
  // Rules cache warm (so patchRules has something to patch), categories cold → the name lookup
  // returns undefined and the success toast is skipped, but the rule is still created + cached.
  mockApi.createEnrichment.mockResolvedValue({ id: 'e9', field: 'description', operator: 'contains', value: 'spotify', categoryId: 'subs' });
  queryClient.setQueryData<Rule[]>(['rules'], []);
  const result = mount(); // NO categories seed

  await act(async () => { await result.current.saveManualRule('spotify', 'subs'); });

  expect(mockApi.createEnrichment).toHaveBeenCalledWith({ value: 'spotify', categoryId: 'subs' });
  expect(queryClient.getQueryData<Rule[]>(['rules'])?.[0]).toMatchObject({ id: 'e9', isNew: true });
  expect(result.current.toast).toBeNull(); // cold taxonomy → no "Rule added — …" toast, no crash
});

// --- updateRule: cold ['rules'] cache means no `before` snapshot → bail, no server write -------

it('updateRule bails on a cold [rules] cache — no PUT, no toast, cache untouched', async () => {
  mockApi.updateEnrichment.mockResolvedValue({ id: 'e1', field: 'description', operator: 'contains', value: 'X', categoryId: 'subs' });
  const result = mount(); // NO rules seed

  await act(async () => { await result.current.updateRule('e1', 'DISNEY', 'subs'); });

  expect(mockApi.updateEnrichment).not.toHaveBeenCalled(); // no `before` → guarded early return
  // Assert the early return fired, not merely that the (undefined before.field) PUT threw:
  // removing the `if (!before) return` guard surfaces the caught-error toast + touches nothing,
  // so a null toast + absent cache only hold when the guard short-circuits.
  expect(result.current.toast).toBeNull();
  expect(queryClient.getQueryData(['rules'])).toBeUndefined();
});
