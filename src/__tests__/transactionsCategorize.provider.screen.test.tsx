// WHIT-190a/192 — the categorise write's cache write + invalidation (the WHIT-193 closure).
// Drives the REAL applyCategory through AppProvider (../api + ../auth mocked) and asserts it
// updates the singleton ['transactions'] feed cache, rolls it back on failure, and invalidates
// ['budgets']/['breakdown'] so the migrated Budgets/Insights screens refresh. The feed itself
// is NOT invalidated (the optimistic patch already wrote it; an InfiniteData invalidate would
// storm every loaded page) — the tests assert that too. (Pre-192 it also wrote an old store.)
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';
import { AppProvider, useAppContext } from '../context';
import type { Transaction } from '../context';
import { queryClient } from '../queryClient';
import { seedTransactionsCache, readTransactionsCache, seedTransactionsPages, type FeedPage } from './support/transactionsCache';

jest.mock('../api');
jest.mock('../auth', () => ({ getStatus: () => 'authed', subscribe: () => () => {} }));
import * as api from '../api';
const mockApi = api as jest.Mocked<typeof api>;

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;

const CAT = { id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#7fd49b', recent: 100 } as const;
const DINING = { id: 'dining', name: 'Dining', bucket: 'Lifestyle', icon: 'utensils', color: '#f7768e', recent: 0 } as const;
const txn = (id: string): Transaction => ({
  transaction_id: id, date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'COLES', merchant_name: 'Coles', amount: -12.5, account_id: 'a1',
  account_name: 'ANZ', category: null, status: 'posted', type: 'PAYMENT', counts_to_budget: true,
});
const cachedCategory = (id: string) => readTransactionsCache(queryClient).find((t) => t.transaction_id === id)?.category;

beforeEach(() => {
  queryClient.clear();
  mockApi.createRule.mockResolvedValue({ id: 'r1', field: 'description', operator: 'contains', value: 'COLES', categoryId: 'groceries' });
  mockApi.setTransactionCategories.mockImplementation(async (updates: { id: string; category: string }[]) => ({ results: updates.map((u) => ({ id: u.id, status: 'updated' as const })) }));
});

// The singleton queryClient's gcTime schedules a timer for inactive cached data;
// clear after each test so no timer leaks past the suite (worker-exit warning).
afterEach(() => {
  queryClient.clear();
});

// WHIT-192: seed the ['transactions'] + ['categories'] caches applyCategory reads (the
// provider no longer eager-loads), then mount.
function mount(transactions: Transaction[] = [txn('t1'), txn('t2')]) {
  seedTransactionsCache(queryClient, transactions);
  queryClient.setQueryData(['categories'], [{ ...CAT }]);
  // ['budgets', cycleLen] caches the RAW Record<categoryId, BudgetRollup> (select maps it).
  queryClient.setQueryData(['budgets', 14], {});
  const { result } = renderHook(() => useAppContext(), { wrapper });
  return result;
}

it('applyCategory(one) writes the tx cache AND invalidates budgets/breakdown but NOT the feed', async () => {
  mockApi.setTransactionCategory.mockResolvedValue({ transaction_id: 't1', category: 'groceries' });
  const result = mount();

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
  await act(async () => { await result.current.applyCategory('one'); });

  expect(cachedCategory('t1')).toBe('groceries'); // query cache write
  const invalidatedKeys = invalidateSpy.mock.calls.map((c) => (c[0] as { queryKey: string[] }).queryKey[0]);
  expect(invalidatedKeys).toEqual(expect.arrayContaining(['budgets', 'breakdown'])); // WHIT-193 closure
  expect(invalidatedKeys).not.toContain('transactions'); // the feed is patched, never invalidated (no page storm)
  invalidateSpy.mockRestore();
});

it('applyCategory(one) rolls the cache back on failure', async () => {
  mockApi.setTransactionCategory.mockRejectedValue(new Error('boom'));
  const result = mount();

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('one'); });

  expect(cachedCategory('t1')).toBeNull(); // query cache reverted
});

it('applyCategory(all) writes every same-merchant charge into the cache + invalidates', async () => {
  const result = mount();

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
  await act(async () => { await result.current.applyCategory('all'); });

  expect(cachedCategory('t1')).toBe('groceries');
  expect(cachedCategory('t2')).toBe('groceries'); // the whole same-merchant sweep hit the cache
  const invalidatedKeys = invalidateSpy.mock.calls.map((c) => (c[0] as { queryKey: string[] }).queryKey[0]);
  expect(invalidatedKeys).toEqual(expect.arrayContaining(['budgets', 'breakdown']));
  expect(invalidatedKeys).not.toContain('transactions'); // feed patched, not invalidated
  invalidateSpy.mockRestore();
});

it('applyCategory(all) rolls back ONLY the failed ids in the cache (partial)', async () => {
  // t2's save comes back not-updated → only t2 reverts; t1 stays categorised.
  mockApi.setTransactionCategories.mockResolvedValue({ results: [{ id: 't1', status: 'updated' as const }] });
  const result = mount();

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('all'); });

  expect(cachedCategory('t1')).toBe('groceries'); // saved → stays
  expect(cachedCategory('t2')).toBeNull(); // not saved → reverted (partial rollback)
});

// WHIT-324: the confirm's "All from this merchant" is now reachable from the detail screen too,
// where the tapped charge can already be categorised. The sweep filters to UNCATEGORISED
// same-merchant charges, so the tapped charge must be force-included or its category never
// changes.
it('applyCategory(all) re-files the tapped charge even when it is already categorised', async () => {
  // t1 already sits under Dining; t2 is uncategorised. Re-filing "all" as Groceries must move
  // BOTH — the tapped t1 (which the sweep filter would otherwise skip) and the swept t2.
  const result = mount([{ ...txn('t1'), category: 'dining' }, txn('t2')]);
  queryClient.setQueryData(['categories'], [{ ...CAT }, { ...DINING }]);

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('all'); });

  expect(cachedCategory('t1')).toBe('groceries'); // tapped charge re-filed despite prior category
  expect(cachedCategory('t2')).toBe('groceries'); // swept in as before
});

it('applyCategory(all) reverts a failed tapped charge to its PREVIOUS category (not null)', async () => {
  mockApi.setTransactionCategories.mockResolvedValue({ results: [] }); // every id fails to save
  const result = mount([{ ...txn('t1'), category: 'dining' }]);
  queryClient.setQueryData(['categories'], [{ ...CAT }, { ...DINING }]);

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('all'); });

  expect(cachedCategory('t1')).toBe('dining'); // failed re-file → back to its real prior category
});

// --- WHIT-355: the "apply to all" tap must not mint a duplicate/clashing rule ---------------

const existingRule = (categoryId: string) => [{ id: 'existing', pattern: 'COLES', categoryId, isNew: false }];

it('[WHIT-355] applyCategory(all) does NOT create a second rule when an identical one exists (duplicate), but still files charges', async () => {
  const result = mount();
  queryClient.setQueryData(['rules'], existingRule('groceries')); // same pattern + same category

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('all'); });

  expect(mockApi.createRule).not.toHaveBeenCalled(); // no duplicate rule minted
  expect(cachedCategory('t1')).toBe('groceries'); // charges still filed
  expect(cachedCategory('t2')).toBe('groceries');
});

it('[WHIT-355] applyCategory(all) neither creates nor changes a rule on a clash, and leaves the existing rule alone', async () => {
  const result = mount();
  queryClient.setQueryData(['categories'], [{ ...CAT }, { ...DINING }]);
  queryClient.setQueryData(['rules'], existingRule('dining')); // same pattern, DIFFERENT category

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('all'); });

  expect(mockApi.createRule).not.toHaveBeenCalled();  // no second, fighting rule
  expect(mockApi.updateRule).not.toHaveBeenCalled();  // existing rule never silently changed
  expect((queryClient.getQueryData(['rules']) as { categoryId: string }[])[0].categoryId).toBe('dining'); // untouched
  expect(cachedCategory('t1')).toBe('groceries'); // the tapped charges still file where the user chose
  expect(cachedCategory('t2')).toBe('groceries');
});

it('[WHIT-355] applyCategory(all) STILL creates a rule when no same-pattern rule exists (happy path preserved)', async () => {
  const result = mount();
  queryClient.setQueryData(['rules'], [{ id: 'other', pattern: 'NETFLIX', categoryId: 'subs', isNew: false }]); // unrelated

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('all'); });

  expect(mockApi.createRule).toHaveBeenCalledWith({ value: 'COLES', categoryId: 'groceries' });
});

// --- WHIT-491: one merchant, two spellings → one rule per distinct spelling ------------------
// BankSync matches future charges by a literal `contains` on ONE stored value, so a single rule
// can't span both banks' spellings of a merchant. The apply-all tap must mint a rule per distinct
// GENUINE spelling it sweeps — without minting a junk rule from a noisy no-merchant charge.

// A charge with a specific description + merchant (the factory is fixed to COLES/Coles).
const merchantTxn = (id: string, description: string, merchant_name: string): Transaction =>
  ({ ...txn(id), description, merchant_name });

it('[WHIT-491] applyCategory(all) mints one rule per distinct spelling of the same merchant', async () => {
  // ANZ sends it spaced; Westpac sends it joined — same clinic, two descriptors. The sweep spans
  // both (normalised match), so BOTH must get a stored rule or future Westpac charges go unfiled.
  const anz = merchantTxn('t1', 'UNIFLEX REMEDIAL MASSAGE', 'UNIFLEX REMEDIAL MASSAGE');
  const westpac = merchantTxn('t2', 'UNIFLEXREMEDIALMASSAGE', 'UNIFLEXREMEDIALMASSAGE');
  const result = mount([anz, westpac]);
  queryClient.setQueryData(['rules'], []);

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('all'); });

  expect(cachedCategory('t1')).toBe('groceries');
  expect(cachedCategory('t2')).toBe('groceries'); // both spellings swept + filed
  // FAIL-ON-REVERT: the pre-491 single-rule code minted only the tapped spelling → 1 call. The fix
  // mints one per distinct spelling → exactly 2, one for each descriptor.
  expect(mockApi.createRule).toHaveBeenCalledTimes(2);
  expect(mockApi.createRule).toHaveBeenCalledWith({ value: 'UNIFLEX REMEDIAL MASSAGE', categoryId: 'groceries' });
  expect(mockApi.createRule).toHaveBeenCalledWith({ value: 'UNIFLEXREMEDIALMASSAGE', categoryId: 'groceries' });
});

it('[WHIT-491] applyCategory(all) does NOT mint a rule from a swept no-merchant pending auth', async () => {
  // The pending authorisation has NO merchant_name — only a noisy `POS AUTHORISATION …` line. It IS
  // swept in (space-preserving fallback), but its full description must never become a stored rule
  // (it would carry the ref/phone tokens and match nothing). Only the tapped clean spelling mints.
  const posted = merchantTxn('t1', 'UNIFLEX REMEDIAL MASSAGE', 'UNIFLEX REMEDIAL MASSAGE');
  const pendingAuth = merchantTxn('t2', 'POS AUTHORISATION   UNIFLEX REMEDIAL MASSAGE   +611800958316AU', '');
  const result = mount([posted, pendingAuth]);
  queryClient.setQueryData(['rules'], []);

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('all'); });

  expect(cachedCategory('t2')).toBe('groceries'); // the pending auth IS swept + filed
  // ...but no rule is minted from its noisy full description.
  expect(mockApi.createRule).toHaveBeenCalledTimes(1);
  expect(mockApi.createRule).toHaveBeenCalledWith({ value: 'UNIFLEX REMEDIAL MASSAGE', categoryId: 'groceries' });
});

it('[WHIT-491] applyCategory(all) dedups spellings that differ only by internal whitespace', async () => {
  // Three swept charges, but two descriptors differ only by a doubled space — the same rule (rule
  // identity folds whitespace). So exactly TWO distinct rules mint, not three.
  const tapped = merchantTxn('t1', 'UNIFLEX MASSAGE', 'UNIFLEX MASSAGE');
  const doubleSpace = merchantTxn('t2', 'UNIFLEX  MASSAGE', 'UNIFLEX  MASSAGE'); // ws-variant of t1
  const joined = merchantTxn('t3', 'UNIFLEXMASSAGE', 'UNIFLEXMASSAGE'); // genuinely distinct
  const result = mount([tapped, doubleSpace, joined]);
  queryClient.setQueryData(['rules'], []);

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('all'); });

  expect(mockApi.createRule).toHaveBeenCalledTimes(2); // ws-variant folded away
  expect(mockApi.createRule).toHaveBeenCalledWith({ value: 'UNIFLEX MASSAGE', categoryId: 'groceries' });
  expect(mockApi.createRule).toHaveBeenCalledWith({ value: 'UNIFLEXMASSAGE', categoryId: 'groceries' });
});

it('[WHIT-491] applyCategory(all) rolls back ONLY the spelling whose rule save failed', async () => {
  // Two spellings mint two rules; the Westpac one fails to save. Only its optimistic row is removed
  // — the ANZ rule keeps its real server id — and the "could not save the rule" toast fires.
  const anz = merchantTxn('t1', 'UNIFLEX REMEDIAL MASSAGE', 'UNIFLEX REMEDIAL MASSAGE');
  const westpac = merchantTxn('t2', 'UNIFLEXREMEDIALMASSAGE', 'UNIFLEXREMEDIALMASSAGE');
  mockApi.createRule.mockImplementation(async ({ value, categoryId }) => {
    if (value === 'UNIFLEXREMEDIALMASSAGE') throw new Error('boom');
    return { id: 'r-anz', field: 'description', operator: 'contains', value, categoryId };
  });
  const result = mount([anz, westpac]);
  queryClient.setQueryData(['rules'], []);

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('all'); });

  const rules = queryClient.getQueryData(['rules']) as { id: string; pattern: string }[];
  expect(rules).toHaveLength(1); // failed spelling's temp row removed; the other stands
  expect(rules[0]).toMatchObject({ id: 'r-anz', pattern: 'UNIFLEX REMEDIAL MASSAGE' }); // real server id swapped in
  expect(cachedCategory('t1')).toBe('groceries'); // charges filed regardless
  expect(cachedCategory('t2')).toBe('groceries');
  expect(result.current.toast).toBe('Filed, but could not save the rule for future charges.');
});

it('[WHIT-491] applyCategory(all) skips only the spelling that clashes with an existing rule, mints the other', async () => {
  // One spelling already has a rule filing it as Dining (a clash); the other spelling is new. Mint
  // the new one, skip the clashing one (never a second fighting rule), and surface the clash.
  const anz = merchantTxn('t1', 'UNIFLEX REMEDIAL MASSAGE', 'UNIFLEX REMEDIAL MASSAGE');
  const westpac = merchantTxn('t2', 'UNIFLEXREMEDIALMASSAGE', 'UNIFLEXREMEDIALMASSAGE');
  const result = mount([anz, westpac]);
  queryClient.setQueryData(['categories'], [{ ...CAT }, { ...DINING }]);
  queryClient.setQueryData(['rules'], [{ id: 'existing', pattern: 'UNIFLEXREMEDIALMASSAGE', categoryId: 'dining', isNew: false }]);

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('all'); });

  // The new spelling mints; the clashing one does not.
  expect(mockApi.createRule).toHaveBeenCalledTimes(1);
  expect(mockApi.createRule).toHaveBeenCalledWith({ value: 'UNIFLEX REMEDIAL MASSAGE', categoryId: 'groceries' });
  expect(mockApi.createRule).not.toHaveBeenCalledWith({ value: 'UNIFLEXREMEDIALMASSAGE', categoryId: 'groceries' });
  expect(mockApi.updateRule).not.toHaveBeenCalled(); // existing rule never silently changed
  expect(cachedCategory('t1')).toBe('groceries'); // charges still file where the user chose
  expect(cachedCategory('t2')).toBe('groceries');
});

// --- WHIT-291: applyCategoryToMany (multi-select batch re-file) ------------------------------

it('applyCategoryToMany re-files exactly the ids in the set, in one batch, + invalidates', async () => {
  const result = mount([txn('t1'), txn('t2'), txn('t3')]);
  const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

  await act(async () => { await result.current.applyCategoryToMany(['t1', 't3'], 'groceries'); });

  expect(cachedCategory('t1')).toBe('groceries');
  expect(cachedCategory('t3')).toBe('groceries');
  expect(cachedCategory('t2')).toBeNull(); // not in the set → untouched
  const keys = invalidateSpy.mock.calls.map((c) => (c[0] as { queryKey: string[] }).queryKey[0]);
  expect(keys).toEqual(expect.arrayContaining(['budgets', 'breakdown']));
  expect(keys).not.toContain('transactions'); // feed patched, not invalidated
  invalidateSpy.mockRestore();
});

it('applyCategoryToMany reverts only the FAILED ids to their previous category (partial)', async () => {
  mockApi.setTransactionCategories.mockResolvedValue({ results: [{ id: 't1', status: 'updated' as const }] }); // t2 not saved
  const result = mount([{ ...txn('t1'), category: 'dining' }, { ...txn('t2'), category: 'dining' }]);
  queryClient.setQueryData(['categories'], [{ ...CAT }, { ...DINING }]);

  await act(async () => { await result.current.applyCategoryToMany(['t1', 't2'], 'groceries'); });

  expect(cachedCategory('t1')).toBe('groceries'); // saved → stays
  expect(cachedCategory('t2')).toBe('dining');    // failed → back to its PREVIOUS category, not null
});

it('applyCategoryToMany drops ids not in the cache and never calls the batch on an empty set', async () => {
  const result = mount([txn('t1')]);
  await act(async () => { await result.current.applyCategoryToMany(['ghost'], 'groceries'); });
  expect(mockApi.setTransactionCategories).not.toHaveBeenCalled(); // nothing real to file
});

// ===== WHIT-190a/192 (folded from transactionsFeedOptimistic.provider.screen.test.tsx) =====
// The feed's InfiniteData cache under optimistic writes — proves a row on a PAGED-IN (page 2)
// batch updates IN PLACE across pages, and the page/cursor structure survives (the write path
// maps its row transform per page; no add/remove). Without the InfiniteData-aware patch/read the
// paged-in row would never update. Drives the REAL applyTransactionEdit + applyCategoryToMany
// through AppProvider (../api + ../auth mocked — same regime as above, at module scope).
describe('the feed InfiniteData cache under optimistic writes', () => {
  const pages = (): FeedPage[] =>
    (queryClient.getQueryData(['transactions']) as { pages: FeedPage[] }).pages;
  const recentRows = (): Transaction[] => queryClient.getQueryData<Transaction[]>(['transactionsRecent']) ?? [];

  beforeEach(() => {
    queryClient.clear();
    mockApi.setTransactionCategories.mockImplementation(async (updates: { id: string; category: string }[]) => ({
      results: updates.map((u) => ({ id: u.id, status: 'updated' as const })),
    }));
  });

  it('applyTransactionEdit updates a PAGE 2 row in place, preserving page boundaries + cursors', async () => {
    mockApi.setTransactionFields.mockResolvedValue({ transaction_id: 'p2', notes: 'hi' });
    seedTransactionsPages(queryClient, [
      { transactions: [txn('p1a'), txn('p1b')], nextCursor: 'cur1' },
      { transactions: [txn('p2')], nextCursor: null },
    ]);
    const { result } = renderHook(() => useAppContext(), { wrapper });

    await act(async () => { await result.current.applyTransactionEdit('p2', { notes: 'hi' }); });

    const p = pages();
    expect(p.length).toBe(2); // structure preserved (not collapsed to one page)
    expect(p[0].transactions.map((t) => t.transaction_id)).toEqual(['p1a', 'p1b']); // page 1 untouched
    expect(p[0].nextCursor).toBe('cur1'); // page 1 cursor intact
    expect(p[1].transactions[0].notes).toBe('hi'); // page 2 row updated in place
    expect(p[1].nextCursor).toBeNull();
  });

  it('applyCategoryToMany re-files a PAGE 2 row across pages without disturbing page 1', async () => {
    seedTransactionsPages(queryClient, [
      { transactions: [txn('p1')], nextCursor: 'cur1' },
      { transactions: [txn('p2')], nextCursor: null },
    ]);
    queryClient.setQueryData(['categories'], [{ ...CAT }]);
    const { result } = renderHook(() => useAppContext(), { wrapper });

    await act(async () => { await result.current.applyCategoryToMany(['p2'], 'groceries'); });

    const p = pages();
    expect(p.length).toBe(2);
    expect(p[1].transactions[0].category).toBe('groceries'); // paged-in row re-filed
    expect(p[0].transactions[0].category).toBeNull(); // page 1 untouched
  });

  // The feed and the bounded ['transactionsRecent'] cache overlap on the newest rows. An edit must
  // patch BOTH, or the tab-bar dot / account-detail / goal-edit (which read recent) keep stale data.
  it('an edit on an OVERLAP charge patches the recent cache too, not just the feed', async () => {
    mockApi.setTransactionFields.mockResolvedValue({ transaction_id: 'p1', notes: 'x' });
    seedTransactionsPages(queryClient, [{ transactions: [txn('p1')], nextCursor: null }]);
    queryClient.setQueryData(['transactionsRecent'], [txn('p1')]); // same charge sits in both caches
    const { result } = renderHook(() => useAppContext(), { wrapper });

    await act(async () => { await result.current.applyTransactionEdit('p1', { notes: 'x' }); });

    expect(pages()[0].transactions[0].notes).toBe('x'); // feed updated
    expect(recentRows()[0].notes).toBe('x'); // recent updated too → dot/account-detail stay live
  });

  // A charge within the recent window but BEYOND the feed's loaded pages is recent-only. The write
  // must still fire — a feed-only lookup would leave `transaction` undefined and silently no-op.
  // FAIL-ON-REVERT: narrow readTransactionsCache back to the feed and setTransactionFields is never
  // called here.
  it('a write on a RECENT-ONLY charge (beyond the feed) actually fires and files it', async () => {
    mockApi.setTransactionFields.mockResolvedValue({ transaction_id: 'r1', notes: 'x' });
    seedTransactionsPages(queryClient, [{ transactions: [txn('feedOnly')], nextCursor: 'cur1' }]); // feed lacks r1
    queryClient.setQueryData(['transactionsRecent'], [txn('r1')]); // r1 lives ONLY in the recent cache
    const { result } = renderHook(() => useAppContext(), { wrapper });

    await act(async () => { await result.current.applyTransactionEdit('r1', { notes: 'x' }); });

    expect(mockApi.setTransactionFields).toHaveBeenCalledWith('r1', { notes: 'x' }); // NOT a silent no-op
    expect(recentRows()[0].notes).toBe('x'); // filed into the recent cache
  });
});

// ===== WHIT-491 QA — adversarial GAP tests (not covered by the implementer's suite above) =====
// Target: allSettled outcome[i]→mints[i] index alignment under N=3 with a MIDDLE reject; per-spelling
// dedup when the TAPPED spelling is the existing duplicate; the toast precedence when charge-batch AND
// a rule both fail; the TAPPED-charge full-description fallback rule; and the ['rules']-cache-absent
// network path. Each proven fail-on-revert (single-mutation red-green) before landing.

// [QA1] — allSettled outcome[i] must map to mints[i] with N=3 and the MIDDLE rule rejecting. NOT the
// implementer's "rolls back ONLY the failed spelling" (that is N=2 with the LAST rule rejecting — an
// off-by-one in the reconcile index would still look correct there).
it('[WHIT-491][QA1] with 3 minted rules, a MIDDLE rejection removes exactly its row and keeps the other two with their real ids', async () => {
  // Three genuinely-distinct spellings (spaces in different places → 3 distinct rule identities) that
  // all normalise to the same stem, so the sweep spans all three and all three mint.
  const a = merchantTxn('t1', 'UNIFLEX REMEDIAL MASSAGE', 'UNIFLEX REMEDIAL MASSAGE');
  const b = merchantTxn('t2', 'UNIFLEXREMEDIALMASSAGE', 'UNIFLEXREMEDIALMASSAGE');
  const c = merchantTxn('t3', 'UNIFLEX REMEDIALMASSAGE', 'UNIFLEX REMEDIALMASSAGE');
  mockApi.createRule.mockImplementation(async ({ value, categoryId }) => {
    if (value === 'UNIFLEXREMEDIALMASSAGE') throw new Error('boom'); // the MIDDLE mint
    return { id: `r-${value}`, field: 'description', operator: 'contains', value, categoryId };
  });
  const result = mount([a, b, c]);
  queryClient.setQueryData(['rules'], []);

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('all'); });

  const rules = queryClient.getQueryData(['rules']) as { id: string; pattern: string }[];
  expect(rules).toHaveLength(2); // the MIDDLE spelling's optimistic row is gone
  // Assert POSITIONALLY, not by a pattern→id map: a fulfilled reconcile overwrites both id and pattern
  // from the server outcome, so a pattern→id lookup can't see an index misalignment. The surviving ROW
  // ORDER [m0, m2] holds only when outcome[i] reconciles mints[i].
  expect(rules.map((r) => r.pattern)).toEqual(['UNIFLEX REMEDIAL MASSAGE', 'UNIFLEX REMEDIALMASSAGE']);
  expect(rules.map((r) => r.id)).toEqual(['r-UNIFLEX REMEDIAL MASSAGE', 'r-UNIFLEX REMEDIALMASSAGE']);
  expect(rules.some((r) => r.pattern === 'UNIFLEXREMEDIALMASSAGE')).toBe(false); // rejected spelling dropped
  expect(mockApi.createRule).toHaveBeenCalledTimes(3);
});

// [QA2] — the per-spelling conflict check is independent: when the TAPPED spelling already has a
// same-category rule (a duplicate → skip) but a SWEPT spelling is new, only the swept one mints. NOT
// the implementer's clash test (that skips a DIFFERENT-category SWEPT spelling); here the SKIP is on
// the TAPPED spelling and the surviving mint is the swept one — the opposite index.
it('[WHIT-491][QA2] tapped spelling is an existing duplicate, swept spelling is new → mints ONLY the swept one', async () => {
  const anz = merchantTxn('t1', 'UNIFLEX REMEDIAL MASSAGE', 'UNIFLEX REMEDIAL MASSAGE'); // tapped
  const westpac = merchantTxn('t2', 'UNIFLEXREMEDIALMASSAGE', 'UNIFLEXREMEDIALMASSAGE');   // new
  const result = mount([anz, westpac]);
  // A same-CATEGORY rule already exists for the tapped spelling → duplicate (skip), not a conflict.
  queryClient.setQueryData(['rules'], [{ id: 'existing', pattern: 'UNIFLEX REMEDIAL MASSAGE', categoryId: 'groceries', isNew: false }]);

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('all'); });

  expect(mockApi.createRule).toHaveBeenCalledTimes(1);
  expect(mockApi.createRule).toHaveBeenCalledWith({ value: 'UNIFLEXREMEDIALMASSAGE', categoryId: 'groceries' });
  expect(mockApi.createRule).not.toHaveBeenCalledWith({ value: 'UNIFLEX REMEDIAL MASSAGE', categoryId: 'groceries' });
  // Not a conflict → the "clash" wording must NOT appear; charges still file.
  expect(result.current.toast).not.toContain('already have a rule');
  expect(cachedCategory('t1')).toBe('groceries');
  expect(cachedCategory('t2')).toBe('groceries');
});

// [QA3] — when the CHARGE batch partially fails AND a rule also rejects in the same tap, the
// charge-failure toast wins and the rule-failure toast is suppressed (they share an if/else-if). No
// implementer test exercises both failures at once.
it('[WHIT-491][QA3] charge-batch partial failure + a rule rejection → only the charge-failure toast shows, rule row still rolled back', async () => {
  const anz = merchantTxn('t1', 'UNIFLEX REMEDIAL MASSAGE', 'UNIFLEX REMEDIAL MASSAGE');
  const westpac = merchantTxn('t2', 'UNIFLEXREMEDIALMASSAGE', 'UNIFLEXREMEDIALMASSAGE');
  // t2's categorisation fails to save (batch returns only t1 updated).
  mockApi.setTransactionCategories.mockResolvedValue({ results: [{ id: 't1', status: 'updated' as const }] });
  // ...and the westpac spelling's rule save also rejects.
  mockApi.createRule.mockImplementation(async ({ value, categoryId }) => {
    if (value === 'UNIFLEXREMEDIALMASSAGE') throw new Error('boom');
    return { id: `r-${value}`, field: 'description', operator: 'contains', value, categoryId };
  });
  const result = mount([anz, westpac]);
  queryClient.setQueryData(['rules'], []);

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('all'); });

  // The charge-failure toast dominates; the "could not save the rule" toast is NOT shown.
  expect(result.current.toast).toBe('Could not save some categories. Please try again.');
  // The failed charge reverted; the saved one stayed.
  expect(cachedCategory('t1')).toBe('groceries');
  expect(cachedCategory('t2')).toBeNull();
  // The rejected rule's optimistic row was still removed; the good rule kept its real id.
  const rules = queryClient.getQueryData(['rules']) as { id: string; pattern: string }[];
  expect(rules).toHaveLength(1);
  expect(rules[0]).toMatchObject({ id: 'r-UNIFLEX REMEDIAL MASSAGE', pattern: 'UNIFLEX REMEDIAL MASSAGE', categoryId: 'groceries', isNew: true });
});

// [QA4] — characterisation: "a no-merchant charge mints no junk rule" applies only to SWEPT charges.
// The TAPPED charge always mints from its rulePattern, which for a no-merchant charge is the FULL
// description (fallback). Deliberate (context.tsx candidate set keeps ruleValue) but worth locking.
it('[WHIT-491][QA4] tapping a no-merchant charge for apply-all mints a full-description fallback rule from the TAPPED charge', async () => {
  const pendingAuth = merchantTxn('t1', 'POS AUTHORISATION   UNIFLEX REMEDIAL MASSAGE   +611800958316AU', '');
  const result = mount([pendingAuth]);
  queryClient.setQueryData(['rules'], []);

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('all'); });

  // The tapped charge's own pattern falls back to the full noisy description and IS minted.
  expect(mockApi.createRule).toHaveBeenCalledTimes(1);
  expect(mockApi.createRule).toHaveBeenCalledWith({
    value: 'POS AUTHORISATION   UNIFLEX REMEDIAL MASSAGE   +611800958316AU', categoryId: 'groceries',
  });
});

// [QA5] — Rules screen never opened → ['rules'] cache is ABSENT. createRule must STILL fire (the
// rule has to reach the server), patchRules no-ops (guarded), and the absent cache is NOT resurrected.
it('[WHIT-491][QA5] with no ["rules"] cache seeded, createRule still fires and the cache is not resurrected', async () => {
  const result = mount(); // COLES/Coles factory; NO queryClient.setQueryData(['rules'], ...)
  expect(queryClient.getQueryData(['rules'])).toBeUndefined(); // precondition: never opened

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('all'); });

  expect(mockApi.createRule).toHaveBeenCalledWith({ value: 'COLES', categoryId: 'groceries' });
  // patchRules is guarded (prev ? fn(prev) : prev) → the absent cache stays absent, no crash.
  expect(queryClient.getQueryData(['rules'])).toBeUndefined();
  // Charges still filed.
  expect(cachedCategory('t1')).toBe('groceries');
  expect(cachedCategory('t2')).toBe('groceries');
});
