// Provider mutation tests (WHIT-90): drive the real AppProvider through its
// category/budget/transaction/loan-facts actions with ../api mocked. WHIT-192: the eager
// store is gone, so the writers read + write the TanStack Query cache directly. These
// tests SEED that cache (the provider no longer eager-loads) and ASSERT on it via
// queryClient.getQueryData, instead of the retired result.current.{transactions,...}.
// Covers applyCategory (one + all), saveBudget, saveCategory (create + edit),
// deleteCategory, saveLoanFacts — success and failure/rollback.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';
import { AppProvider, useAppContext } from '../context';
import type { Transaction, Category, Rule, LoanFacts } from '../context';
import { queryClient } from '../queryClient';

jest.mock('../api');
// The writers guard the load-error banner on auth (retired), but auth still gates
// nothing in these direct-action tests; pin 'authed' for parity with the app.
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

// Read helpers over the query caches the writers now target.
const txns = () => queryClient.getQueryData<Transaction[]>(['transactions']) ?? [];
const cats = () => queryClient.getQueryData<Category[]>(['categories']) ?? [];
const rules = () => queryClient.getQueryData<Rule[]>(['rules']) ?? [];
const loanFacts = () => queryClient.getQueryData<LoanFacts>(['loanFacts']);

beforeEach(() => {
  // The module-singleton queryClient carries gcTime-5min timers; clear it around each
  // test so those timers don't outlive the suite (the "worker failed to exit" warning).
  queryClient.clear();
  // Batch category write (WHIT-70): default to "all updated", echoing the ids sent.
  mockApi.setTransactionCategories.mockImplementation(
    async (updates: { id: string; category: string }[]) =>
      ({ results: updates.map((u) => ({ id: u.id, status: 'updated' as const })) }));
});
afterEach(() => {
  queryClient.clear();
});

// WHIT-192: seed the query caches the writers read (the provider no longer eager-loads).
// `txnList` overrides the transactions the sweep tests operate on.
function seed(txnList: readonly Transaction[] = [{ ...TXN }]) {
  queryClient.setQueryData(['transactions'], txnList.map((t) => ({ ...t })));
  queryClient.setQueryData(['categories'], [{ ...CAT }]);
  // The ['budgets', cycleLen] cache holds the RAW queryFn shape: a
  // Record<categoryId, BudgetRollup> keyed by id (useBudgetsQuery maps it via `select`).
  queryClient.setQueryData(['budgets', 14], {});
  queryClient.setQueryData(['payCycle'], { length: 14, last_pay_date: '2024-01-03' });
  queryClient.setQueryData(['loanFacts'], { original: null, homeValue: null, lvr: null, ratePct: null, baseRepay: null, extra: null });
  queryClient.setQueryData(['rules'], []);
}

function mount() {
  const { result } = renderHook(() => useAppContext(), { wrapper });
  return result;
}

// --- applyCategory -----------------------------------------------------------

it('applyCategory(one) files the transaction and persists it', async () => {
  mockApi.setTransactionCategory.mockResolvedValue({ transaction_id: 't1', category: 'groceries' });
  seed();
  const result = mount();

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('one'); });

  expect(mockApi.setTransactionCategory).toHaveBeenCalledWith('t1', 'groceries');
  expect(txns()[0].category).toBe('groceries');
  expect(result.current.sheet).toBeNull();
});

it('applyCategory(one) rolls the category back on failure', async () => {
  mockApi.setTransactionCategory.mockRejectedValue(new Error('boom'));
  seed();
  const result = mount();

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('one'); });

  expect(txns()[0].category).toBeNull();
  expect(result.current.toast).toBe('Could not save category. Please try again.');
});

it('applyCategory(all) files every same-merchant charge — and ONLY that merchant — then creates a rule', async () => {
  // t1/t2: same Coles merchant → both get filed. t3: a different merchant whose
  // description happens to contain the "COLES" token but whose merchant_name is
  // Woolworths → must be EXCLUDED by the same-merchant gate, proving the sweep
  // keys on merchant_name, not a loose description match.
  mockApi.createEnrichment.mockResolvedValue({ id: 'e1', field: 'description', operator: 'contains', value: 'COLES', categoryId: 'groceries' });
  seed([
    { ...TXN, transaction_id: 't1' },
    { ...TXN, transaction_id: 't2' },
    { ...TXN, transaction_id: 't3', description: 'WOOLWORTHS NEAR COLES ST', merchant_name: 'Woolworths' },
  ]);
  const result = mount();

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('all'); });

  // ONE batch call (WHIT-70), not N single PATCHes — carrying t1 + t2 only, NOT t3.
  expect(mockApi.setTransactionCategories).toHaveBeenCalledTimes(1);
  expect(mockApi.setTransactionCategory).not.toHaveBeenCalled();
  expect(mockApi.setTransactionCategories.mock.calls[0][0].map((u) => u.id).sort()).toEqual(['t1', 't2']);
  expect(mockApi.createEnrichment).toHaveBeenCalledWith({ value: 'COLES', categoryId: 'groceries' });

  const byId = Object.fromEntries(txns().map((t) => [t.transaction_id, t.category]));
  expect(byId.t1).toBe('groceries');
  expect(byId.t2).toBe('groceries');
  expect(byId.t3).toBeNull();                                        // Woolworths untouched
  expect(rules()).toHaveLength(1);
});

it('applyCategory(all) sweeps same-merchant charges tagged with a RAW bank category, not just null ones', async () => {
  // The "uncategorized" charges the user sees can carry a raw BankSync enum (e.g.
  // FOOD_AND_DRINK), NOT null. The sweep must catch those too — a plain
  // category==null check silently skipped them (the KKV bug). A charge already
  // filed under a real user category must NOT be swept (don't overwrite it).
  mockApi.createEnrichment.mockResolvedValue({ id: 'e1', field: 'description', operator: 'contains', value: 'COLES', categoryId: 'groceries' });
  seed([
    { ...TXN, transaction_id: 't1', category: null },              // tapped origin (null)
    { ...TXN, transaction_id: 't2', category: 'FOOD_AND_DRINK' },  // raw enum, same merchant -> MUST sweep
    { ...TXN, transaction_id: 't3', category: 'groceries' },       // real user category -> must NOT touch
  ]);
  const result = mount();

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('all'); });

  // t1 (null) + t2 (raw enum) swept in ONE batch; t3 (already groceries) left alone.
  expect(mockApi.setTransactionCategories).toHaveBeenCalledTimes(1);
  const swept = mockApi.setTransactionCategories.mock.calls[0][0].map((u) => u.id).sort();
  expect(swept).toEqual(['t1', 't2']);
  const byId = Object.fromEntries(txns().map((t) => [t.transaction_id, t.category]));
  expect(byId.t2).toBe('groceries');   // the FOOD_AND_DRINK charge is now filed
});

it('applyCategory(all) rolls back only the ids the batch reports as not saved', async () => {
  // Partial server success: the batch files t1 but reports t2 not_found. Only t2
  // reverts (to uncategorised); t1 stays filed. Rollback keys BY ID, not position.
  mockApi.createEnrichment.mockResolvedValue({ id: 'e1', field: 'description', operator: 'contains', value: 'COLES', categoryId: 'groceries' });
  mockApi.setTransactionCategories.mockResolvedValue({
    results: [{ id: 't1', status: 'updated' }, { id: 't2', status: 'not_found' }],
  });
  seed([
    { ...TXN, transaction_id: 't1', category: null },
    { ...TXN, transaction_id: 't2', category: null },
  ]);
  const result = mount();

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('all'); });

  const byId = Object.fromEntries(txns().map((t) => [t.transaction_id, t.category]));
  expect(byId.t1).toBe('groceries');   // saved -> stays
  expect(byId.t2).toBeNull();          // not_found -> reverted
  expect(result.current.toast).toBe('Could not save some categories. Please try again.');
});

it('applyCategory(all) rolls back ALL ids when the whole batch call rejects', async () => {
  mockApi.createEnrichment.mockResolvedValue({ id: 'e1', field: 'description', operator: 'contains', value: 'COLES', categoryId: 'groceries' });
  mockApi.setTransactionCategories.mockRejectedValue(new Error('network'));
  seed([
    { ...TXN, transaction_id: 't1', category: null },
    { ...TXN, transaction_id: 't2', category: null },
  ]);
  const result = mount();

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('all'); });

  const byId = Object.fromEntries(txns().map((t) => [t.transaction_id, t.category]));
  expect(byId.t1).toBeNull();
  expect(byId.t2).toBeNull();
  expect(result.current.toast).toBe('Could not save some categories. Please try again.');
});

it('applyCategory(all) invalidates budgets + breakdown when at least one charge saved', async () => {
  mockApi.createEnrichment.mockResolvedValue({ id: 'e1', field: 'description', operator: 'contains', value: 'COLES', categoryId: 'groceries' });
  // Partial: t1 saved, t2 not — still >=1 saved, so spend changed -> a refresh MUST fire.
  mockApi.setTransactionCategories.mockResolvedValue({
    results: [{ id: 't1', status: 'updated' }, { id: 't2', status: 'not_found' }],
  });
  seed([
    { ...TXN, transaction_id: 't1', category: null },
    { ...TXN, transaction_id: 't2', category: null },
  ]);
  const result = mount();
  const invalidate = jest.spyOn(queryClient, 'invalidateQueries');

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('all'); });

  // WHIT-192: the migrated Budgets/Insights screens read the query cache, so a
  // categorisation invalidates those keys (was: eager refreshBudgets/refreshBreakdown).
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['budgets'] });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['breakdown'] });
  invalidate.mockRestore();
});

it('applyCategory(all) does NOT invalidate budgets/breakdown when the whole batch fails', async () => {
  mockApi.createEnrichment.mockResolvedValue({ id: 'e1', field: 'description', operator: 'contains', value: 'COLES', categoryId: 'groceries' });
  mockApi.setTransactionCategories.mockRejectedValue(new Error('network'));
  seed([
    { ...TXN, transaction_id: 't1', category: null },
    { ...TXN, transaction_id: 't2', category: null },
  ]);
  const result = mount();
  const invalidate = jest.spyOn(queryClient, 'invalidateQueries');

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('all'); });

  // All reverted -> nothing persisted -> spend unchanged -> no wasted invalidation.
  expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['budgets'] });
  expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['breakdown'] });
  invalidate.mockRestore();
});

it('applyCategory(all) does NOT call the batch when the sweep is empty', async () => {
  // Origin doesn't count to a budget -> excluded from sameMerchantIds -> empty set.
  // A real server 400s on {updates:[]}; the client must not send it at all (E1 fix).
  mockApi.createEnrichment.mockResolvedValue({ id: 'e1', field: 'description', operator: 'contains', value: 'COLES', categoryId: 'groceries' });
  seed([{ ...TXN, transaction_id: 't1', category: null, counts_to_budget: false }]);
  const result = mount();

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('all'); });

  expect(mockApi.setTransactionCategories).not.toHaveBeenCalled();
});

it('applyCategory(all) splits a >100 sweep into chunks of 100 (WHIT-70 chunking)', async () => {
  // 150 same-merchant uncategorised charges -> the sweep must send TWO batch calls
  // (100 + 50), not one oversized request the server would 400.
  const many = Array.from({ length: 150 }, (_, i) => ({ ...TXN, transaction_id: `t${i}`, category: null }));
  mockApi.createEnrichment.mockResolvedValue({ id: 'e1', field: 'description', operator: 'contains', value: 'COLES', categoryId: 'groceries' });
  seed(many);
  const result = mount();

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't0', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('all'); });

  expect(mockApi.setTransactionCategories).toHaveBeenCalledTimes(2);
  const sizes = mockApi.setTransactionCategories.mock.calls.map((c) => c[0].length).sort((a, b) => b - a);
  expect(sizes).toEqual([100, 50]);
  // Both chunks succeed (default echo mock) -> all 150 filed.
  expect(txns().filter((t) => t.category === 'groceries')).toHaveLength(150);
});

it('applyCategory(all) reverts only the failed chunk when one of several rejects', async () => {
  const many = Array.from({ length: 150 }, (_, i) => ({ ...TXN, transaction_id: `t${i}`, category: null }));
  mockApi.createEnrichment.mockResolvedValue({ id: 'e1', field: 'description', operator: 'contains', value: 'COLES', categoryId: 'groceries' });
  // First chunk (100) succeeds; second chunk (50) rejects -> only those 50 revert.
  mockApi.setTransactionCategories.mockImplementation(async (updates: { id: string; category: string }[]) => {
    if (updates.length !== 100) throw new Error('chunk failed');
    return { results: updates.map((u) => ({ id: u.id, status: 'updated' as const })) };
  });
  seed(many);
  const result = mount();

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't0', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('all'); });

  const byId = Object.fromEntries(txns().map((t) => [t.transaction_id, t.category]));
  expect(byId.t0).toBe('groceries');   // first chunk (t0..t99) saved
  expect(byId.t149).toBeNull();        // second chunk (t100..t149) rejected -> reverted
  expect(txns().filter((t) => t.category === 'groceries')).toHaveLength(100);
  expect(result.current.toast).toBe('Could not save some categories. Please try again.');
});

// --- saveBudget --------------------------------------------------------------

it('saveBudget persists a target and returns true', async () => {
  mockApi.setBudget.mockResolvedValue({ id: 'groceries', target: 300 });
  seed();
  const result = mount();

  let ok: boolean | undefined;
  await act(async () => { ok = await result.current.saveBudget('groceries', 300); });

  expect(ok).toBe(true);
  expect(mockApi.setBudget).toHaveBeenCalledWith('groceries', 300);
});

it('saveBudget rejects a non-positive target without calling the API', async () => {
  seed();
  const result = mount();
  let ok: boolean | undefined;
  await act(async () => { ok = await result.current.saveBudget('groceries', 0); });
  expect(ok).toBe(false);
  expect(mockApi.setBudget).not.toHaveBeenCalled();
});

it('saveBudget returns false + toasts on failure', async () => {
  mockApi.setBudget.mockRejectedValue(new Error('x'));
  seed();
  const result = mount();
  let ok: boolean | undefined;
  await act(async () => { ok = await result.current.saveBudget('groceries', 300); });
  expect(ok).toBe(false);
  expect(result.current.toast).toBe('Could not save budget. Please try again.');
});

it('saveBudget rejects a Savings-bucket category without calling the API (WHIT-202)', async () => {
  // A Savings category can't carry a target (the Budgets screens skip it), so the writer
  // must short-circuit before the doomed round-trip — the deep-link/back-door class.
  seed();
  queryClient.setQueryData(['categories'], [
    { ...CAT },
    { id: 'nest_egg', name: 'Nest Egg', bucket: 'Savings', icon: 'piggy', color: '#8fd4c0', recent: 0 },
  ]);
  const result = mount();
  let ok: boolean | undefined;
  await act(async () => { ok = await result.current.saveBudget('nest_egg', 300); });
  expect(ok).toBe(false);
  expect(mockApi.setBudget).not.toHaveBeenCalled();
  expect(result.current.toast).toBe("Savings categories can't be budgeted.");
});

it('saveBudget on an uncached (cold) category falls through to the server, not the Savings short-circuit (WHIT-202)', async () => {
  // Cold ['categories'] cache: the category isn't cached, so saveBudget CANNOT know it's
  // Savings — it must fall through to the server (the 400 backstop), never silently succeed
  // or wrongly fire the Savings short-circuit. Here the server rejects; the writer surfaces
  // the GENERIC save-failed toast. Fail-on-revert: if the short-circuit fired on an
  // undefined bucket, setBudget would never be called and the toast would be the Savings copy.
  seed(); // categories = [CAT] only; 'nest_egg' is NOT in the cache
  mockApi.setBudget.mockRejectedValue(new Error('400'));
  const result = mount();

  let ok: boolean | undefined;
  await act(async () => { ok = await result.current.saveBudget('nest_egg', 300); });

  expect(mockApi.setBudget).toHaveBeenCalledWith('nest_egg', 300); // hit the server (no short-circuit)
  expect(ok).toBe(false);
  expect(result.current.toast).toBe('Could not save budget. Please try again.');
});

// --- deleteBudget ------------------------------------------------------------

it('deleteBudget removes the target from the budgets cache, calls the API, and toasts', async () => {
  mockApi.deleteBudget.mockResolvedValue({ id: 'groceries' });
  seed();
  // A stored target for 'groceries' in the RAW ['budgets', cycleLen] Record.
  queryClient.setQueryData(['budgets', 14], { groceries: { target: 300, posted: 40, pending: 10 } });
  const result = mount();

  let ok: boolean | undefined;
  await act(async () => { ok = await result.current.deleteBudget('groceries'); });

  expect(ok).toBe(true);
  expect(mockApi.deleteBudget).toHaveBeenCalledWith('groceries');
  // The id is stripped from the cache optimistically (before the invalidate reconciles).
  expect(queryClient.getQueryData(['budgets', 14])).toEqual({});
  expect(result.current.toast).toBe('Groceries budget removed.');
});

it('deleteBudget returns false, restores the cache, and toasts on failure', async () => {
  mockApi.deleteBudget.mockRejectedValue(new Error('x'));
  seed();
  const before = { groceries: { target: 300, posted: 40, pending: 10 } };
  queryClient.setQueryData(['budgets', 14], { ...before });
  const result = mount();

  let ok: boolean | undefined;
  await act(async () => { ok = await result.current.deleteBudget('groceries'); });

  expect(ok).toBe(false);
  // The optimistic strip is rolled back to the pre-delete snapshot.
  expect(queryClient.getQueryData(['budgets', 14])).toEqual(before);
  expect(result.current.toast).toBe('Could not remove budget. Please try again.');
});

// --- saveCategory ------------------------------------------------------------

it('saveCategory creates a new category', async () => {
  mockApi.createCategory.mockResolvedValue({ id: 'gym', name: 'Gym', bucket: 'Lifestyle', icon: 'dumbbell', color: '#f00', recent: 0 });
  seed();
  const result = mount();

  let ok: boolean | undefined;
  await act(async () => { ok = await result.current.saveCategory(null, { name: 'Gym', bucket: 'Lifestyle', icon: 'dumbbell' }); });

  expect(ok).toBe(true);
  expect(mockApi.createCategory).toHaveBeenCalledWith({ name: 'Gym', bucket: 'Lifestyle', icon: 'dumbbell' });
  expect(cats().some((c) => c.id === 'gym')).toBe(true);
});

it('saveCategory edits an existing category in place', async () => {
  mockApi.updateCategory.mockResolvedValue({ id: 'groceries', name: 'Supermarket', bucket: 'Living', icon: 'cart', color: '#0f0', recent: 0 });
  seed();
  const result = mount();

  let ok: boolean | undefined;
  await act(async () => { ok = await result.current.saveCategory('groceries', { name: 'Supermarket', bucket: 'Living', icon: 'cart' }); });

  expect(ok).toBe(true);
  expect(mockApi.updateCategory).toHaveBeenCalledWith('groceries', { name: 'Supermarket', bucket: 'Living', icon: 'cart' });
  expect(cats().find((c) => c.id === 'groceries')?.name).toBe('Supermarket');
});

it('saveCategory threads a chosen parent through (create + edit); omitting it leaves the link alone', async () => {
  // WHIT-221: the category-edit screen manages the parent link. When it passes `parent`
  // (an id, or null to detach) it must reach the API; when a caller omits it, the field
  // must NOT be sent (server leave-as-is) — that's what the two tests above assert.
  mockApi.createCategory.mockResolvedValue({ id: 'parking', name: 'Parking', bucket: 'Living', icon: 'car', color: '#f00', recent: 0, parent: 'car' });
  mockApi.updateCategory.mockResolvedValue({ id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#0f0', recent: 0, parent: null });
  seed();
  const result = mount();

  await act(async () => { await result.current.saveCategory(null, { name: 'Parking', bucket: 'Living', icon: 'car', parent: 'car' }); });
  expect(mockApi.createCategory).toHaveBeenCalledWith({ name: 'Parking', bucket: 'Living', icon: 'car', parent: 'car' });

  await act(async () => { await result.current.saveCategory('groceries', { name: 'Groceries', bucket: 'Living', icon: 'cart', parent: null }); });
  expect(mockApi.updateCategory).toHaveBeenCalledWith('groceries', { name: 'Groceries', bucket: 'Living', icon: 'cart', parent: null });
});

it('saveCategory returns false + toasts on failure', async () => {
  mockApi.createCategory.mockRejectedValue(new Error('x'));
  seed();
  const result = mount();
  let ok: boolean | undefined;
  await act(async () => { ok = await result.current.saveCategory(null, { name: 'Gym', bucket: 'Lifestyle', icon: 'dumbbell' }); });
  expect(ok).toBe(false);
  expect(result.current.toast).toBe('Could not save category. Please try again.');
});

// --- createCategoryInline (WHIT-237/238) -------------------------------------

it('createCategoryInline returns the created category and mirrors it into the cache', async () => {
  mockApi.createCategory.mockResolvedValue({ id: 'gym', name: 'Gym', bucket: 'Lifestyle', icon: 'dumbbell', color: '#f00', recent: 0, parent: null });
  seed();
  const result = mount();

  let created: unknown;
  await act(async () => { created = await result.current.createCategoryInline({ name: 'Gym', bucket: 'Lifestyle', icon: 'dumbbell', parent: null }); });

  // Returns the CATEGORY (not a boolean) so a caller can file/re-parent against its id...
  expect((created as { id: string } | null)?.id).toBe('gym');
  expect(mockApi.createCategory).toHaveBeenCalledWith({ name: 'Gym', bucket: 'Lifestyle', icon: 'dumbbell', parent: null });
  // ...and it's mirrored into the cache so it's pickable immediately.
  expect(cats().some((c) => c.id === 'gym')).toBe(true);
});

// WHIT-240: the writers toast by default, but an orchestrated bulk save (category/edit) opts
// into { silent: true } so the screen can show ONE summary toast instead of one per write.
it('createCategoryInline toasts by default, and stays silent with { silent: true }', async () => {
  mockApi.createCategory.mockResolvedValue({ id: 'gym', name: 'Gym', bucket: 'Lifestyle', icon: 'dumbbell', color: '#f00', recent: 0, parent: null });
  seed();
  const result = mount();
  // Silent FIRST, from the null baseline: no toast. Fail-on-revert: drop the `if (!opts?.silent)`
  // gate and toast is set here → this null assertion fails.
  await act(async () => { await result.current.createCategoryInline({ name: 'Bus', bucket: 'Living', icon: 'car', parent: null }, { silent: true }); });
  expect(result.current.toast).toBeNull();
  // Default: the writer fires its own toast (proves the silent case above isn't vacuous).
  await act(async () => { await result.current.createCategoryInline({ name: 'Gym', bucket: 'Lifestyle', icon: 'dumbbell', parent: null }); });
  expect(result.current.toast).toBe('Category created.');
});

it('saveCategory (update) toasts by default, and stays silent with { silent: true }', async () => {
  mockApi.updateCategory.mockResolvedValue({ id: 'groceries', name: 'Supermarket', bucket: 'Living', icon: 'cart', color: '#0f0', recent: 0 });
  seed();
  const result = mount();
  await act(async () => { await result.current.saveCategory('groceries', { name: 'Supermarket', bucket: 'Living', icon: 'cart' }, { silent: true }); });
  expect(result.current.toast).toBeNull();
  await act(async () => { await result.current.saveCategory('groceries', { name: 'Supermarket', bucket: 'Living', icon: 'cart' }); });
  expect(result.current.toast).toBe('Category updated.');
});

// WHIT-240: silent must also suppress the FAILURE toast — a bulk save owns the whole outcome
// (its summary reports the failure count), so a silent write must stay silent even when it fails.
// Fail-on-revert: ungate the catch-branch showToast and this null assertion goes red.
it('createCategoryInline stays silent on failure with { silent: true }', async () => {
  mockApi.createCategory.mockRejectedValue(new Error('x'));
  seed();
  const result = mount();
  let created: unknown;
  await act(async () => { created = await result.current.createCategoryInline({ name: 'Gym', bucket: 'Lifestyle', icon: 'dumbbell' }, { silent: true }); });
  expect(created).toBeNull();               // still reports failure via the return value
  expect(result.current.toast).toBeNull();  // ...but fires no toast of its own
});

it('createCategoryInline returns null + toasts on failure', async () => {
  mockApi.createCategory.mockRejectedValue(new Error('x'));
  seed();
  const result = mount();
  let created: unknown = 'unset';
  await act(async () => { created = await result.current.createCategoryInline({ name: 'Gym', bucket: 'Lifestyle', icon: 'dumbbell' }); });
  expect(created).toBeNull();
  expect(result.current.toast).toBe('Could not save category. Please try again.');
});

// --- deleteCategory ----------------------------------------------------------

it('deleteCategory removes it (cache cascade) and returns true', async () => {
  mockApi.deleteCategory.mockResolvedValue({ id: 'groceries' });
  seed();
  const result = mount();

  let ok: boolean | undefined;
  await act(async () => { ok = await result.current.deleteCategory('groceries'); });

  expect(ok).toBe(true);
  expect(mockApi.deleteCategory).toHaveBeenCalledWith('groceries');
  expect(cats().some((c) => c.id === 'groceries')).toBe(false);
});

it('deleteCategory returns false + toasts on failure', async () => {
  mockApi.deleteCategory.mockRejectedValue(new Error('x'));
  seed();
  const result = mount();
  let ok: boolean | undefined;
  await act(async () => { ok = await result.current.deleteCategory('groceries'); });
  expect(ok).toBe(false);
  expect(result.current.toast).toBe('Could not delete category. Please try again.');
});

// --- saveLoanFacts (Loan facts card) -----------------------------------------

const FACTS = { original: 600000, homeValue: 770000, lvr: 0.8, ratePct: 5.74, baseRepay: 1240, extra: 200 };

it('saveLoanFacts persists + optimistically updates the cache, returns true', async () => {
  mockApi.setLoanFacts.mockResolvedValue(FACTS);
  seed();
  const result = mount();
  let ok: boolean | undefined;
  await act(async () => { ok = await result.current.saveLoanFacts(FACTS); });
  expect(ok).toBe(true);
  expect(mockApi.setLoanFacts).toHaveBeenCalledWith(FACTS);
  expect(loanFacts()?.homeValue).toBe(770000);
});

it('saveLoanFacts rolls the cache back + toasts on failure', async () => {
  mockApi.setLoanFacts.mockRejectedValue(new Error('x'));
  seed();  // seeds all-null facts
  const result = mount();
  let ok: boolean | undefined;
  await act(async () => { ok = await result.current.saveLoanFacts(FACTS); });
  expect(ok).toBe(false);
  // Rolled back to the pre-save (unset) cache; the user is told.
  expect(loanFacts()?.homeValue).toBeNull();
  expect(result.current.toast).toBe('Could not save loan details. Please try again.');
});
