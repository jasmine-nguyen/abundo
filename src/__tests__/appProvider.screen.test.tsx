// Provider mutation tests (WHIT-90): drive the real AppProvider through its
// category/budget/transaction/loan-facts actions, with requests on the fake server. WHIT-192: the
// eager store is gone, so the writers read + write the TanStack Query cache directly. These
// tests SEED that cache (the provider no longer eager-loads) and ASSERT on it via
// queryClient.getQueryData, instead of the retired result.current.{transactions,...}.
// Covers applyCategory (one + all), saveBudget, saveCategory (create + edit),
// deleteCategory, saveLoanFacts — success and failure/rollback.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';
import { AppProvider, useAppContext } from '../context';
import type { LoanFacts } from '../context';
import type { Transaction, Category } from '../types';
import type { Rule } from '../model';
import { queryClient } from '../queryClient';
import { seedTransactionsCache, readTransactionsCache } from './support/transactionsCache';
import { installFakeServer, type LoggedRequest } from './support/fakeServer';
import { GROCERIES } from './support/categories';
import { DELETE_GROCERIES } from './support/deleteCategorySeed';
import { colesTxn } from './factory';
import { appProviderWrapper as wrapper } from './support/renderWithApp';

// The writers guard the load-error banner on auth (retired), but auth still gates
// nothing in these direct-action tests; pin 'authed' for parity with the app.
jest.mock('../auth', () => require('./support/authMock').authMockModule());

const server = installFakeServer();

const CAT = GROCERIES;
const TXN = colesTxn();

// Read helpers over the query caches the writers now target.
const txns = () => readTransactionsCache(queryClient);
const cats = () => queryClient.getQueryData<Category[]>(['categories']) ?? [];
const rules = () => queryClient.getQueryData<Rule[]>(['rules']) ?? [];
const loanFacts = () => queryClient.getQueryData<LoanFacts>(['loanFacts']);
const bodies = (requests: LoggedRequest[]) => requests.map((request) => request.body);
const batchIds = (batch: LoggedRequest) =>
  (batch.body as { updates: { id: string }[] }).updates.map((update) => update.id);

beforeEach(() => {
  // The module-singleton queryClient carries gcTime-5min timers; clear it around each
  // test so those timers don't outlive the suite (the "worker failed to exit" warning).
  queryClient.clear();
});
afterEach(() => {
  queryClient.clear();
});

// WHIT-192: seed the query caches the writers read (the provider no longer eager-loads).
// `txnList` overrides the transactions the sweep tests operate on. The fake server's category
// list matches the cache, so a category write updates a real row.
function seed(txnList: readonly Transaction[] = [{ ...TXN }]) {
  server.seed('/categories', [CAT]);
  seedTransactionsCache(queryClient, txnList.map((t) => ({ ...t })));
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


// --- WHIT-437: the server's reason reaches the toast --------------------------
// These run against the REAL provider and request code on the fake server, so they also prove the
// path src/components/Overlays.tsx uses (createAndFile calls createCategoryInline with no opts and
// therefore inherits this fix with zero code change of its own).

const CAP_REASON = 'a category can have at most 50 sub-categories';

it('createCategoryInline toasts the server reason and still returns null', async () => {
  server.once('POST', '/categories', { status: 400, reason: CAP_REASON });
  seed();
  const result = mount();
  let created: unknown = 'unset';
  await act(async () => { created = await result.current.createCategoryInline({ name: 'Gym', bucket: 'Lifestyle', icon: 'dumbbell' }); });
  expect(result.current.toast).toBe('A category can have at most 50 sub-categories.');
  // null, not a throw: Overlays.tsx's `else setSubmitting(false)` depends on this branch.
  expect(created).toBeNull();
});

it('saveCategory toasts the depth reason', async () => {
  server.once('PATCH', '/categories/groceries', { status: 400, reason: 'categories can be nested at most 5 levels deep' });
  seed();
  const result = mount();
  await act(async () => { await result.current.saveCategory('groceries', { name: 'Groceries', bucket: 'Living', icon: 'cart' }); });
  expect(result.current.toast).toBe('Categories can be nested at most 5 levels deep.');
});

it('deleteCategory toasts the too-wide-to-detach reason', async () => {
  const detach = "'cafes-coffee' has 73 sub-categories — too many to detach in one write; move some out from under it first";
  server.once('DELETE', '/categories/cafes-coffee', { status: 400, reason: detach });
  seed();
  const result = mount();
  await act(async () => { await result.current.deleteCategory('cafes-coffee'); });
  expect(result.current.toast).toBe(`${detach}.`);
});

it('keeps the generic copy when the failure explains nothing', async () => {
  server.once('POST', '/categories', 'dropped');
  seed();
  const result = mount();
  await act(async () => { await result.current.createCategoryInline({ name: 'Gym', bucket: 'Lifestyle', icon: 'dumbbell' }); });
  expect(result.current.toast).toBe('Could not save category. Please try again.');
});

it('keeps the generic copy for a 5xx that did explain itself', async () => {
  server.once('DELETE', '/categories/groceries', { status: 500, reason: 'internal boom' });
  seed();
  const result = mount();
  await act(async () => { await result.current.deleteCategory('groceries'); });
  expect(result.current.toast).toBe('Could not delete category. Please try again.');
});

// --- applyCategory -----------------------------------------------------------

it('applyCategory(one) files the transaction and persists it', async () => {
  seed();
  const result = mount();

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('one'); });

  expect(bodies(server.sent('PATCH', '/transactions/t1'))).toEqual([{ category: 'groceries' }]);
  expect(txns()[0].category).toBe('groceries');
  expect(result.current.sheet).toBeNull();
});

it('applyCategory(one) rolls the category back on failure', async () => {
  server.once('PATCH', '/transactions/t1', 'dropped');
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
  seed([
    { ...TXN, transaction_id: 't1' },
    { ...TXN, transaction_id: 't2' },
    { ...TXN, transaction_id: 't3', description: 'WOOLWORTHS NEAR COLES ST', merchant_name: 'Woolworths' },
  ]);
  const result = mount();

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('all'); });

  // ONE batch call (WHIT-70), not N single PATCHes — carrying t1 + t2 only, NOT t3.
  const batches = server.sent('PATCH', '/transactions');
  expect(batches).toHaveLength(1);
  expect(server.sentUnder('PATCH', '/transactions/')).toEqual([]);
  expect(batchIds(batches[0]).sort()).toEqual(['t1', 't2']);
  expect(bodies(server.sent('POST', '/rules'))).toEqual([{ value: 'COLES', categoryId: 'groceries' }]);

  const byId = Object.fromEntries(txns().map((t) => [t.transaction_id, t.category]));
  expect(byId.t1).toBe('groceries');
  expect(byId.t2).toBe('groceries');
  expect(byId.t3).toBeNull();                                        // Woolworths untouched
  expect(rules()).toHaveLength(1);
  // WHIT-292: the sweep toast names the count it filed alongside the future rule (t1 + t2).
  expect(result.current.toast).toBe('2 transactions filed — future COLES charges file as Groceries.');
});

it('applyCategory(all) sweeps same-merchant charges tagged with a RAW bank category, not just null ones', async () => {
  // The "uncategorized" charges the user sees can carry a raw BankSync enum (e.g.
  // FOOD_AND_DRINK), NOT null. The sweep must catch those too — a plain
  // category==null check silently skipped them (the KKV bug). A charge already
  // filed under a real user category must NOT be swept (don't overwrite it).
  seed([
    { ...TXN, transaction_id: 't1', category: null },              // tapped origin (null)
    { ...TXN, transaction_id: 't2', category: 'FOOD_AND_DRINK' },  // raw enum, same merchant -> MUST sweep
    { ...TXN, transaction_id: 't3', category: 'groceries' },       // real user category -> must NOT touch
  ]);
  const result = mount();

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('all'); });

  // t1 (null) + t2 (raw enum) swept in ONE batch; t3 (already groceries) left alone.
  const batches = server.sent('PATCH', '/transactions');
  expect(batches).toHaveLength(1);
  const swept = batchIds(batches[0]).sort();
  expect(swept).toEqual(['t1', 't2']);
  const byId = Object.fromEntries(txns().map((t) => [t.transaction_id, t.category]));
  expect(byId.t2).toBe('groceries');   // the FOOD_AND_DRINK charge is now filed
});

it('applyCategory(all) rolls back only the ids the batch reports as not saved', async () => {
  // Partial server success: the batch files t1 but reports t2 not_found. Only t2
  // reverts (to uncategorised); t1 stays filed. Rollback keys BY ID, not position.
  server.once('PATCH', '/transactions', {
    body: { results: [{ id: 't1', status: 'updated' }, { id: 't2', status: 'not_found' }] },
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
  server.once('PATCH', '/transactions', 'dropped');
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

it('applyCategory(all) toasts rule-only failure (charges filed, optimistic rule rolled back) when the rule fails but the batch succeeds', async () => {
  // WHIT-292 gap: the rule-only-failure branch (context.tsx "Filed, but could not save the
  // rule…") had ZERO coverage, and it's exactly the branch the batch/rule extraction moves.
  // createRule rejects while every charge saves -> charges stay filed, the optimistic
  // rule is removed, and the toast is the rule-only copy (NOT the generic "some categories").
  // Also locks the concurrency structure: the rule is ISSUED before the batch, and its
  // rejection never floats as an unhandled rejection (allSettled attached synchronously).
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  server.once('POST', '/rules', { status: 500 });
  seed([
    { ...TXN, transaction_id: 't1', category: null },
    { ...TXN, transaction_id: 't2', category: null },
  ]);
  const result = mount();

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('all'); });

  const byId = Object.fromEntries(txns().map((t) => [t.transaction_id, t.category]));
  expect(byId.t1).toBe('groceries');                 // charges stay filed (batch succeeded)
  expect(byId.t2).toBe('groceries');
  expect(rules()).toHaveLength(0);                   // optimistic rule rolled back (rule failed)
  expect(result.current.toast).toBe('Filed, but could not save the rule for future charges.');
  // Concurrency: the rule is issued BEFORE the batch (prior call order), matching the old
  // single Promise.allSettled([createRule, ...chunks]).
  const sentInOrder = server.requests();
  const ruleAt = sentInOrder.findIndex((request) => request.method === 'POST' && request.path === '/rules');
  const firstBatchAt = sentInOrder.findIndex((request) => request.method === 'PATCH' && request.path === '/transactions');
  expect(ruleAt).toBeGreaterThanOrEqual(0);
  expect(ruleAt).toBeLessThan(firstBatchAt);

  process.off('unhandledRejection', onUnhandled);
  expect(unhandled).toEqual([]);                     // rule rejection handled, never floated
});

it('applyCategory(all) invalidates budgets + breakdown when at least one charge saved', async () => {
  // Partial: t1 saved, t2 not — still >=1 saved, so spend changed -> a refresh MUST fire.
  server.once('PATCH', '/transactions', {
    body: { results: [{ id: 't1', status: 'updated' }, { id: 't2', status: 'not_found' }] },
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
  server.once('PATCH', '/transactions', 'dropped');
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

it('applyCategory(all) files the tapped charge even when the sweep is empty (never an empty batch)', async () => {
  // WHIT-324: the tapped charge doesn't count to a budget, so the merchant SWEEP is empty — but
  // the charge the user explicitly picked is still filed. The batch therefore carries exactly
  // that one id, and is never sent empty (a real server 400s on {updates:[]}; the E1 guard).
  seed([{ ...TXN, transaction_id: 't1', category: null, counts_to_budget: false }]);
  const result = mount();

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('all'); });

  const batches = server.sent('PATCH', '/transactions');
  expect(batches).toHaveLength(1);
  expect(batches[0].body).toEqual({ updates: [{ id: 't1', category: 'groceries' }] });
});

it('applyCategory(all) splits a >100 sweep into chunks of 100 (WHIT-70 chunking)', async () => {
  // 150 same-merchant uncategorised charges -> the sweep must send TWO batch calls
  // (100 + 50), not one oversized request the server would 400.
  const many = Array.from({ length: 150 }, (_, i) => ({ ...TXN, transaction_id: `t${i}`, category: null }));
  seed(many);
  const result = mount();

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't0', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('all'); });

  const batches = server.sent('PATCH', '/transactions');
  expect(batches).toHaveLength(2);
  const sizes = batches.map((batch) => batchIds(batch).length).sort((a, b) => b - a);
  expect(sizes).toEqual([100, 50]);
  // Both chunks succeed (the fake server echoes every id as updated) -> all 150 filed.
  expect(txns().filter((t) => t.category === 'groceries')).toHaveLength(150);
});

it('applyCategory(all) reverts only the failed chunk when one of several rejects', async () => {
  const many = Array.from({ length: 150 }, (_, i) => ({ ...TXN, transaction_id: `t${i}`, category: null }));
  // First chunk (t0..t99) succeeds; the second (t100..t149) is lost -> only those 50 revert.
  const first100 = many.slice(0, 100).map((t) => t.transaction_id);
  server.once('PATCH', '/transactions', { body: { results: first100.map((id) => ({ id, status: 'updated' })) } });
  server.once('PATCH', '/transactions', 'dropped');
  seed(many);
  const result = mount();

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't0', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('all'); });

  // The scripted success reply matches the first batch actually sent.
  expect(batchIds(server.sent('PATCH', '/transactions')[0])).toEqual(first100);
  const byId = Object.fromEntries(txns().map((t) => [t.transaction_id, t.category]));
  expect(byId.t0).toBe('groceries');   // first chunk (t0..t99) saved
  expect(byId.t149).toBeNull();        // second chunk (t100..t149) rejected -> reverted
  expect(txns().filter((t) => t.category === 'groceries')).toHaveLength(100);
  expect(result.current.toast).toBe('Could not save some categories. Please try again.');
});

// --- saveBudget --------------------------------------------------------------

it('saveBudget persists a target and returns true', async () => {
  seed();
  const result = mount();

  let ok: boolean | undefined;
  await act(async () => { ok = await result.current.saveBudget('groceries', 300); });

  expect(ok).toBe(true);
  expect(bodies(server.sent('PUT', '/budgets/groceries'))).toEqual([{ target: 300 }]);
});

it('saveBudget rejects a non-positive target without calling the API', async () => {
  seed();
  const result = mount();
  let ok: boolean | undefined;
  await act(async () => { ok = await result.current.saveBudget('groceries', 0); });
  expect(ok).toBe(false);
  expect(server.sentUnder('PUT', '/budgets/')).toEqual([]);
});

it('saveBudget returns false + toasts on failure', async () => {
  server.once('PUT', '/budgets/groceries', 'dropped');
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
    { id: 'nest_egg', name: 'Nest Egg', bucket: 'Savings', icon: 'piggy', color: '#8fd4c0' },
  ]);
  const result = mount();
  let ok: boolean | undefined;
  await act(async () => { ok = await result.current.saveBudget('nest_egg', 300); });
  expect(ok).toBe(false);
  expect(server.sentUnder('PUT', '/budgets/')).toEqual([]);
  expect(result.current.toast).toBe("Savings categories can't be budgeted.");
});

it('saveBudget on an uncached (cold) category falls through to the server, not the Savings short-circuit (WHIT-202)', async () => {
  // Cold ['categories'] cache: the category isn't cached, so saveBudget CANNOT know it's
  // Savings — it must fall through to the server (the 400 backstop), never silently succeed
  // or wrongly fire the Savings short-circuit. Here the server rejects; the writer surfaces
  // the GENERIC save-failed toast. Fail-on-revert: if the short-circuit fired on an
  // undefined bucket, no PUT would be sent and the toast would be the Savings copy.
  seed(); // categories = [CAT] only; 'nest_egg' is NOT in the cache
  server.once('PUT', '/budgets/nest_egg', { status: 400 });
  const result = mount();

  let ok: boolean | undefined;
  await act(async () => { ok = await result.current.saveBudget('nest_egg', 300); });

  expect(bodies(server.sent('PUT', '/budgets/nest_egg'))).toEqual([{ target: 300 }]); // hit the server (no short-circuit)
  expect(ok).toBe(false);
  expect(result.current.toast).toBe('Could not save budget. Please try again.');
});

// --- deleteBudget ------------------------------------------------------------

it('deleteBudget removes the target from the budgets cache, calls the API, and toasts', async () => {
  seed();
  // A stored target for 'groceries' in the RAW ['budgets', cycleLen] Record.
  queryClient.setQueryData(['budgets', 14], { groceries: { target: 300, posted: 40, pending: 10 } });
  const result = mount();

  let ok: boolean | undefined;
  await act(async () => { ok = await result.current.deleteBudget('groceries'); });

  expect(ok).toBe(true);
  expect(server.sent('DELETE', '/budgets/groceries')).toHaveLength(1);
  // The id is stripped from the cache optimistically (before the invalidate reconciles).
  expect(queryClient.getQueryData(['budgets', 14])).toEqual({});
  expect(result.current.toast).toBe('Groceries budget removed.');
});

it('deleteBudget returns false, restores the cache, and toasts on failure', async () => {
  server.once('DELETE', '/budgets/groceries', 'dropped');
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
  server.once('POST', '/categories', { body: { id: 'gym', name: 'Gym', bucket: 'Lifestyle', icon: 'dumbbell', color: '#f00' } });
  seed();
  const result = mount();

  let ok: boolean | undefined;
  await act(async () => { ok = await result.current.saveCategory(null, { name: 'Gym', bucket: 'Lifestyle', icon: 'dumbbell' }); });

  expect(ok).toBe(true);
  expect(bodies(server.sent('POST', '/categories'))).toEqual([{ name: 'Gym', bucket: 'Lifestyle', icon: 'dumbbell' }]);
  expect(cats().some((c) => c.id === 'gym')).toBe(true);
});

it('saveCategory edits an existing category in place', async () => {
  server.once('PATCH', '/categories/groceries', { body: { id: 'groceries', name: 'Supermarket', bucket: 'Living', icon: 'cart', color: '#0f0' } });
  seed();
  const result = mount();

  let ok: boolean | undefined;
  await act(async () => { ok = await result.current.saveCategory('groceries', { name: 'Supermarket', bucket: 'Living', icon: 'cart' }); });

  expect(ok).toBe(true);
  expect(bodies(server.sent('PATCH', '/categories/groceries'))).toEqual([{ name: 'Supermarket', bucket: 'Living', icon: 'cart' }]);
  expect(cats().find((c) => c.id === 'groceries')?.name).toBe('Supermarket');
});

it('saveCategory threads a chosen parent through (create + edit); omitting it leaves the link alone', async () => {
  // WHIT-221: the category-edit screen manages the parent link. When it passes `parent`
  // (an id, or null to detach) it must reach the API; when a caller omits it, the field
  // must NOT be sent (server leave-as-is) — that's what the two tests above assert.
  server.once('POST', '/categories', { body: { id: 'parking', name: 'Parking', bucket: 'Living', icon: 'car', color: '#f00', parent: 'car' } });
  server.once('PATCH', '/categories/groceries', { body: DELETE_GROCERIES });
  seed();
  const result = mount();

  await act(async () => { await result.current.saveCategory(null, { name: 'Parking', bucket: 'Living', icon: 'car', parent: 'car' }); });
  expect(bodies(server.sent('POST', '/categories'))).toEqual([{ name: 'Parking', bucket: 'Living', icon: 'car', parent: 'car' }]);

  await act(async () => { await result.current.saveCategory('groceries', { name: 'Groceries', bucket: 'Living', icon: 'cart', parent: null }); });
  expect(bodies(server.sent('PATCH', '/categories/groceries'))).toEqual([{ name: 'Groceries', bucket: 'Living', icon: 'cart', parent: null }]);
});

it('saveCategory returns false + toasts on failure', async () => {
  server.once('POST', '/categories', 'dropped');
  seed();
  const result = mount();
  let ok: boolean | undefined;
  await act(async () => { ok = await result.current.saveCategory(null, { name: 'Gym', bucket: 'Lifestyle', icon: 'dumbbell' }); });
  expect(ok).toBe(false);
  expect(result.current.toast).toBe('Could not save category. Please try again.');
});

// --- createCategoryInline (WHIT-237/238) -------------------------------------

const GYM_ROW = { id: 'gym', name: 'Gym', bucket: 'Lifestyle', icon: 'dumbbell', color: '#f00', parent: null };

it('createCategoryInline returns the created category and mirrors it into the cache', async () => {
  server.once('POST', '/categories', { body: GYM_ROW });
  seed();
  const result = mount();

  let created: unknown;
  await act(async () => { created = await result.current.createCategoryInline({ name: 'Gym', bucket: 'Lifestyle', icon: 'dumbbell', parent: null }); });

  // Returns the CATEGORY (not a boolean) so a caller can file/re-parent against its id...
  expect((created as { id: string } | null)?.id).toBe('gym');
  expect(bodies(server.sent('POST', '/categories'))).toEqual([{ name: 'Gym', bucket: 'Lifestyle', icon: 'dumbbell', parent: null }]);
  // ...and it's mirrored into the cache so it's pickable immediately.
  expect(cats().some((c) => c.id === 'gym')).toBe(true);
});

// WHIT-240: the writers toast by default, but an orchestrated bulk save (category/edit) opts
// into { silent: true } so the screen can show ONE summary toast instead of one per write.
it('createCategoryInline toasts by default, and stays silent with { silent: true }', async () => {
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
  seed();
  const result = mount();
  await act(async () => { await result.current.saveCategory('groceries', { name: 'Supermarket', bucket: 'Living', icon: 'cart' }, { silent: true }); });
  expect(result.current.toast).toBeNull();
  await act(async () => { await result.current.saveCategory('groceries', { name: 'Supermarket', bucket: 'Living', icon: 'cart' }); });
  expect(result.current.toast).toBe('Category updated.');
});

// WHIT-240: silent must suppress the FAILURE toast — a bulk save owns the whole outcome (its
// summary reports the failure count), so a silent write must stay silent even when it fails.
// WHIT-437 changed HOW it reports: it now REJECTS with the error rather than returning null, so
// the caller can fold the server's reason into its own summary line. The promise this test
// exists for — a silent write fires no toast of its own — is unchanged and still pinned below.
// Fail-on-revert: ungate the catch-branch showToast and the toast assertion goes red.
it('createCategoryInline stays silent on failure with { silent: true }', async () => {
  server.once('POST', '/categories', 'dropped');
  seed();
  const result = mount();
  await act(async () => {
    await expect(
      result.current.createCategoryInline({ name: 'Gym', bucket: 'Lifestyle', icon: 'dumbbell' }, { silent: true }),
    ).rejects.toThrow('Network request failed'); // reports failure by rejecting, so the reason survives
  });
  expect(result.current.toast).toBeNull();  // ...but fires no toast of its own
});

// WHIT-437: the UPDATE writer's silent-reject needs its own pin. The card's headline journey —
// attaching an existing sub-category to a parent already at 50 — runs through saveCategory, not
// createCategoryInline, so without this the line can be reverted with the whole suite still green.
it('saveCategory stays silent on failure with { silent: true } and rejects', async () => {
  server.once('PATCH', '/categories/groceries', { status: 400, reason: CAP_REASON });
  seed();
  const result = mount();
  await act(async () => {
    await expect(
      result.current.saveCategory('groceries', { name: 'Groceries', bucket: 'Living', icon: 'cart' }, { silent: true }),
    ).rejects.toThrow('API error: 400');    // reports by rejecting, so the reason survives
  });
  expect(result.current.toast).toBeNull(); // ...but fires no toast of its own (WHIT-240)
});

it('createCategoryInline returns null + toasts on failure', async () => {
  server.once('POST', '/categories', 'dropped');
  seed();
  const result = mount();
  let created: unknown = 'unset';
  await act(async () => { created = await result.current.createCategoryInline({ name: 'Gym', bucket: 'Lifestyle', icon: 'dumbbell' }); });
  expect(created).toBeNull();
  expect(result.current.toast).toBe('Could not save category. Please try again.');
});

// --- deleteCategory ----------------------------------------------------------

it('deleteCategory removes it (cache cascade) and returns true', async () => {
  seed();
  const result = mount();

  let ok: boolean | undefined;
  await act(async () => { ok = await result.current.deleteCategory('groceries'); });

  expect(ok).toBe(true);
  expect(server.sent('DELETE', '/categories/groceries')).toHaveLength(1);
  expect(cats().some((c) => c.id === 'groceries')).toBe(false);
});

it('deleteCategory returns false + toasts on failure', async () => {
  server.once('DELETE', '/categories/groceries', 'dropped');
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
  seed();
  const result = mount();
  let ok: boolean | undefined;
  await act(async () => { ok = await result.current.saveLoanFacts(FACTS); });
  expect(ok).toBe(true);
  expect(bodies(server.sent('PUT', '/loanfacts'))).toEqual([FACTS]);
  expect(loanFacts()?.homeValue).toBe(770000);
});

it('saveLoanFacts rolls the cache back + toasts on failure', async () => {
  server.once('PUT', '/loanfacts', 'dropped');
  seed();  // seeds all-null facts
  const result = mount();
  let ok: boolean | undefined;
  await act(async () => { ok = await result.current.saveLoanFacts(FACTS); });
  expect(ok).toBe(false);
  // Rolled back to the pre-save (unset) cache; the user is told.
  expect(loanFacts()?.homeValue).toBeNull();
  expect(result.current.toast).toBe('Could not save loan details. Please try again.');
});
