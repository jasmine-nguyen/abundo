// WHIT-190a/192 — the categorise write's cache write + invalidation (the WHIT-193 closure).
// Drives the REAL applyCategory through AppProvider (../auth mocked, the fake server answering) and asserts it
// updates the singleton ['transactions'] feed cache, rolls it back on failure, and invalidates
// ['budgets']/['breakdown'] so the migrated Budgets/Insights screens refresh.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { renderHook, act } from '@testing-library/react-native';
import { useAppContext } from '../context';
import type { Transaction } from '../types';
import { queryClient } from '../queryClient';
import { seedTransactionsCache, readTransactionsCache, seedTransactionsPages, type FeedPage } from './support/transactionsCache';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
import { installFakeServer } from './support/fakeServer';
import { DINING, GROCERIES } from './support/categories';
import { invalidatedKeys } from './support/queryClient';
import { colesTxn } from './factory';
import { appProviderWrapper as wrapper } from './support/renderWithApp';

const server = installFakeServer();
const ruleMints = () => server.sent('POST', '/rules');
const ruleMintBodies = () => ruleMints().map((r) => r.body);
const ruleUpdates = () => server.sentUnder('PUT', '/rules/');
const batchSaves = () => server.sent('PATCH', '/transactions');

const CAT = GROCERIES;
const txn = (id: string) => colesTxn({ transaction_id: id });
const cachedCategory = (id: string) => readTransactionsCache(queryClient).find((t) => t.transaction_id === id)?.category;

// The fake server mints a well-formed rule and reports every batch id updated unless a test queues otherwise.
beforeEach(() => {
  queryClient.clear();
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
  const result = mount();

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
  await act(async () => { await result.current.applyCategory('one'); });

  expect(cachedCategory('t1')).toBe('groceries'); // query cache write
  const keys = invalidatedKeys(invalidateSpy);
  expect(keys).toEqual(expect.arrayContaining(['budgets', 'breakdown'])); // WHIT-193 closure
  invalidateSpy.mockRestore();
});

it('applyCategory(one) rolls the cache back on failure', async () => {
  server.fail('/transactions/t1', 500);
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
  const keys = invalidatedKeys(invalidateSpy);
  expect(keys).toEqual(expect.arrayContaining(['budgets', 'breakdown']));
  invalidateSpy.mockRestore();
});

it('applyCategory(all) rolls back ONLY the failed ids in the cache (partial)', async () => {
  // t2's save comes back not-updated → only t2 reverts; t1 stays categorised.
  server.once('PATCH', '/transactions', { body: { results: [{ id: 't1', status: 'updated' }] } });
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
  server.once('PATCH', '/transactions', { body: { results: [] } }); // every id fails to save
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

  expect(ruleMints()).toHaveLength(0); // no duplicate rule minted
  expect(cachedCategory('t1')).toBe('groceries'); // charges still filed
  expect(cachedCategory('t2')).toBe('groceries');
});

it('[WHIT-355] applyCategory(all) neither creates nor changes a rule on a clash, and leaves the existing rule alone', async () => {
  const result = mount();
  queryClient.setQueryData(['categories'], [{ ...CAT }, { ...DINING }]);
  queryClient.setQueryData(['rules'], existingRule('dining')); // same pattern, DIFFERENT category

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('all'); });

  expect(ruleMints()).toHaveLength(0);   // no second, fighting rule
  expect(ruleUpdates()).toHaveLength(0); // existing rule never silently changed
  expect((queryClient.getQueryData(['rules']) as { categoryId: string }[])[0].categoryId).toBe('dining'); // untouched
  expect(cachedCategory('t1')).toBe('groceries'); // the tapped charges still file where the user chose
  expect(cachedCategory('t2')).toBe('groceries');
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
  expect(ruleMints()).toHaveLength(2);
  expect(ruleMintBodies()).toContainEqual({ value: 'UNIFLEX REMEDIAL MASSAGE', categoryId: 'groceries' });
  expect(ruleMintBodies()).toContainEqual({ value: 'UNIFLEXREMEDIALMASSAGE', categoryId: 'groceries' });
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
  expect(ruleMints()).toHaveLength(1);
  expect(ruleMintBodies()).toContainEqual({ value: 'UNIFLEX REMEDIAL MASSAGE', categoryId: 'groceries' });
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

  expect(ruleMints()).toHaveLength(2); // ws-variant folded away
  expect(ruleMintBodies()).toContainEqual({ value: 'UNIFLEX MASSAGE', categoryId: 'groceries' });
  expect(ruleMintBodies()).toContainEqual({ value: 'UNIFLEXMASSAGE', categoryId: 'groceries' });
});

it('[WHIT-491] applyCategory(all) rolls back ONLY the spelling whose rule save failed', async () => {
  // Two spellings mint two rules; the Westpac one fails to save. Only its optimistic row is removed
  // — the ANZ rule keeps its real server id — and the "could not save the rule" toast fires.
  const anz = merchantTxn('t1', 'UNIFLEX REMEDIAL MASSAGE', 'UNIFLEX REMEDIAL MASSAGE');
  const westpac = merchantTxn('t2', 'UNIFLEXREMEDIALMASSAGE', 'UNIFLEXREMEDIALMASSAGE');
  // Rules mint in sweep order: the ANZ spelling, then the Westpac one.
  server.once('POST', '/rules', { body: { id: 'r-anz', field: 'description', operator: 'contains', value: 'UNIFLEX REMEDIAL MASSAGE', categoryId: 'groceries' } });
  server.once('POST', '/rules', { status: 500 });
  const result = mount([anz, westpac]);
  queryClient.setQueryData(['rules'], []);

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('all'); });

  const rules = queryClient.getQueryData(['rules']) as { id: string; pattern: string }[];
  expect(rules).toHaveLength(1); // failed spelling's temp row removed; the other stands
  expect(rules[0]).toMatchObject({ id: 'r-anz', pattern: 'UNIFLEX REMEDIAL MASSAGE', isNew: true }); // real server id swapped in, NEW badge kept
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
  expect(ruleMints()).toHaveLength(1);
  expect(ruleMintBodies()).toContainEqual({ value: 'UNIFLEX REMEDIAL MASSAGE', categoryId: 'groceries' });
  expect(ruleMintBodies()).not.toContainEqual({ value: 'UNIFLEXREMEDIALMASSAGE', categoryId: 'groceries' });
  expect(ruleUpdates()).toHaveLength(0); // existing rule never silently changed
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
  const keys = invalidatedKeys(invalidateSpy);
  expect(keys).toEqual(expect.arrayContaining(['budgets', 'breakdown']));
  invalidateSpy.mockRestore();
});

it('applyCategoryToMany reverts only the FAILED ids to their previous category (partial)', async () => {
  server.once('PATCH', '/transactions', { body: { results: [{ id: 't1', status: 'updated' }] } }); // t2 not saved
  const result = mount([{ ...txn('t1'), category: 'dining' }, { ...txn('t2'), category: 'dining' }]);
  queryClient.setQueryData(['categories'], [{ ...CAT }, { ...DINING }]);

  await act(async () => { await result.current.applyCategoryToMany(['t1', 't2'], 'groceries'); });

  expect(cachedCategory('t1')).toBe('groceries'); // saved → stays
  expect(cachedCategory('t2')).toBe('dining');    // failed → back to its PREVIOUS category, not null
});

// ===== WHIT-190a/192 (folded from transactionsFeedOptimistic.provider.screen.test.tsx) =====
// The feed's InfiniteData cache under optimistic writes — proves a row on a PAGED-IN (page 2)
// batch updates IN PLACE across pages, and the page/cursor structure survives (the write path
// maps its row transform per page; no add/remove). Without the InfiniteData-aware patch/read the
// paged-in row would never update. Drives the REAL applyTransactionEdit + applyCategoryToMany
// through AppProvider (../auth mocked + the fake server — same regime as above, at module scope).
describe('the feed InfiniteData cache under optimistic writes', () => {
  const pages = (): FeedPage[] =>
    (queryClient.getQueryData(['transactions']) as { pages: FeedPage[] }).pages;
  const recentRows = (): Transaction[] => queryClient.getQueryData<Transaction[]>(['transactionsRecent']) ?? [];

  beforeEach(() => {
    queryClient.clear();
  });

  it('applyTransactionEdit updates a PAGE 2 row in place, preserving page boundaries + cursors', async () => {
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

  // The feed and the bounded ['transactionsRecent'] cache overlap on the newest rows. An edit must
  // patch BOTH, or the tab-bar dot / account-detail / goal-edit (which read recent) keep stale data.
  it('an edit on an OVERLAP charge patches the recent cache too, not just the feed', async () => {
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
    seedTransactionsPages(queryClient, [{ transactions: [txn('feedOnly')], nextCursor: 'cur1' }]); // feed lacks r1
    queryClient.setQueryData(['transactionsRecent'], [txn('r1')]); // r1 lives ONLY in the recent cache
    const { result } = renderHook(() => useAppContext(), { wrapper });

    await act(async () => { await result.current.applyTransactionEdit('r1', { notes: 'x' }); });

    expect(server.requests()).toContainEqual({ method: 'PATCH', path: '/transactions/r1', body: { notes: 'x' } }); // NOT a silent no-op
    expect(recentRows()[0].notes).toBe('x'); // filed into the recent cache
  });
});

// --- WHIT-292: writer-level edges of the shared batch helper -------------------------------

// The `updates` of every batch save the app sent, in order.
const batches = () => batchSaves().map((r) => (r.body as { updates: { id: string; category: string }[] }).updates);

// [A-EMPTY] applyCategory('all') with an EMPTY merchant sweep still ISSUES the rule AND files the
// tapped charge — the rule is independent of the sweep, and the tapped charge is the user's
// explicit pick (WHIT-324). Fail-on-revert: gate createRule on sameMerchantIds.length > 0, or drop
// the tapped charge from the set, and the assertions below go red.
it("applyCategory('all') files the tapped charge and mints the rule when the sweep is empty", async () => {
  server.once('POST', '/rules', { body: { id: 'e1', field: 'description', operator: 'contains', value: 'COLES', categoryId: 'groceries' } });
  // Origin doesn't count to a budget -> no OTHER charge is swept; only the tapped charge is filed.
  const result = mount([{ ...txn('t1'), counts_to_budget: false }]);
  queryClient.setQueryData(['rules'], []);

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('all'); });

  expect(batches()).toEqual([[{ id: 't1', category: 'groceries' }]]);  // the tapped charge is filed
  expect(ruleMintBodies()).toContainEqual({ value: 'COLES', categoryId: 'groceries' }); // rule STILL fires
  // The optimistic rule was reconciled to the real id (not rolled back) and survives.
  expect(queryClient.getQueryData(['rules'])).toMatchObject([{ id: 'e1' }]);
  // WHIT-324: the tapped charge counts, so the toast names the one it just filed.
  expect(result.current.toast).toBe('1 transaction filed — future COLES charges file as Groceries.');
});

// [A-DEDUPE] applyCategoryToMany collapses duplicate ids to ONE update — a double-tapped selection
// must not send the same id twice. Fail-on-revert: drop the `new Set(...)` dedupe and the batch
// would carry two {id:'t1'} rows.
it('applyCategoryToMany dedupes repeated ids to a single batch update', async () => {
  const result = mount([txn('t1')]);

  await act(async () => { await result.current.applyCategoryToMany(['t1', 't1', 't1'], 'groceries'); });

  expect(batches()).toEqual([[{ id: 't1', category: 'groceries' }]]);
});
