// WHIT-203 — the shared hooks the second-tier readers moved onto: useCategories (the
// taxonomy the pickers / category screens / rules label / tab badge read), usePayCycle
// (the Settings row + pay-cycle sheet), and useBudgetDetailScreenData (the budget-detail
// screen). ../api + ../auth mocked; real QueryClientProvider.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { renderHook, waitFor, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

let mockAuthStatus = 'authed';
jest.mock('../auth', () => ({ getStatus: () => mockAuthStatus, subscribe: () => () => {} }));

const mockFetchCategories = jest.fn<() => Promise<unknown>>();
const mockFetchPayCycle = jest.fn<() => Promise<unknown>>();
const mockFetchBudgets = jest.fn<() => Promise<unknown>>();
const mockFetchTransactions = jest.fn<() => Promise<unknown>>();
const mockFetchBudgetTransactions = jest.fn<(id: string) => Promise<unknown>>();
const mockFetchCategoryTransactions = jest.fn<(id: string, cycle: number) => Promise<unknown>>(); // WHIT-342/374 (folded)
jest.mock('../api', () => ({
  fetchCategories: () => mockFetchCategories(),
  fetchPayCycle: () => mockFetchPayCycle(),
  fetchBudgets: () => mockFetchBudgets(),
  fetchTransactions: () => mockFetchTransactions(),
  fetchBudgetTransactions: (id: string) => mockFetchBudgetTransactions(id),
  fetchCategoryTransactions: (id: string, cycle: number) => mockFetchCategoryTransactions(id, cycle),
}));

import { useCategories, usePayCycle, useBudgetDetailScreenData, useBudgetsScreenData, useCategoryCycleTransactionsQuery, useCategoryTransactionsScreenData, categoriesKey } from '../queries';

const CATS = [{ id: 'coffee', name: 'Coffee', bucket: 'Lifestyle', icon: 'coffee', color: '#E8A87C', recent: 0 }];

function makeClient(staleTime = 60_000) {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime, gcTime: Infinity } } });
}
const wrapper = (client: QueryClient) =>
  ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

beforeEach(() => {
  mockAuthStatus = 'authed';
  mockFetchCategories.mockReset().mockResolvedValue(CATS);
  mockFetchPayCycle.mockReset().mockResolvedValue({ length: 30, last_pay_date: '2024-01-03' });
  mockFetchBudgets.mockReset().mockResolvedValue({ coffee: { target: 100, posted: 40, pending: 10 } });
  mockFetchTransactions.mockReset().mockResolvedValue([]);
  mockFetchBudgetTransactions.mockReset().mockResolvedValue([]);
});

it('useCategories maps the list + a null-tolerant lookup, and does not fetch before login', async () => {
  mockAuthStatus = 'anon';
  const anon = renderHook(() => useCategories(), { wrapper: wrapper(makeClient()) });
  expect(mockFetchCategories).not.toHaveBeenCalled();
  expect(anon.result.current.categories).toEqual([]);
  expect(anon.result.current.category('coffee')).toBeUndefined();

  mockAuthStatus = 'authed';
  const { result } = renderHook(() => useCategories(), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(result.current.categories).toHaveLength(1));
  expect(result.current.category('coffee')?.name).toBe('Coffee');
  expect(result.current.category(null)).toBeUndefined();
});

it('usePayCycle derives the cycle name from the fetched length', async () => {
  const { result } = renderHook(() => usePayCycle(), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(result.current.cycleLen).toBe(30));
  expect(result.current.cycleName()).toBe('Monthly');
});

it('useBudgetDetailScreenData assembles the budget list + budgets + categories for the given id', async () => {
  mockFetchBudgetTransactions.mockReset().mockResolvedValue([{ transaction_id: 'x', category: 'coffee', date: '2026-07-18' }]);
  const { result } = renderHook(() => useBudgetDetailScreenData('coffee'), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  expect(result.current.cycleLen).toBe(30);
  expect(result.current.category('coffee')?.name).toBe('Coffee');
  expect(result.current.budgets).toEqual([{ id: 'coffee', budget: 100, posted: 40, pending: 10, rollover: false, carryover: 0 }]);
  expect(mockFetchBudgetTransactions).toHaveBeenCalledWith('coffee'); // the list is fetched per-budget
  expect(result.current.transactions).toHaveLength(1);
  expect(result.current.isError).toBe(false);
});

// WHIT-204: the composite routes its status through the shared useCombineScreenQueries helper.
// These two lock that the budget-transactions query is actually in that array (the array-
// transcription risk the plan-critic flagged) — a list failure must surface as isError, and
// refetchStale must re-fire the list read.
it('useBudgetDetailScreenData surfaces a budget-transactions read failure as isError (not a stranded spinner)', async () => {
  mockFetchBudgetTransactions.mockReset().mockRejectedValue(new Error('API error: 500'));
  const { result } = renderHook(() => useBudgetDetailScreenData('coffee'), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(result.current.isError).toBe(true)); // budgetTransactionsQuery IS in the OR
  expect(result.current.isLoading).toBe(false);                   // errored dependency → not an endless spinner
});

it('useBudgetDetailScreenData refetchStale re-fires every stale read exactly once (incl. the list)', async () => {
  const { result } = renderHook(() => useBudgetDetailScreenData('coffee'), { wrapper: wrapper(makeClient(0)) });
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  await waitFor(() => expect(mockFetchBudgetTransactions).toHaveBeenCalledTimes(1));

  await act(async () => { result.current.refetchStale(); });
  // staleTime 0 → immediately stale → each read (the budget list included) refires once.
  await waitFor(() => expect(mockFetchBudgetTransactions).toHaveBeenCalledTimes(2)); // budgetTransactionsQuery IS in refetchStale
  expect(mockFetchBudgets).toHaveBeenCalledTimes(2);
  expect(mockFetchCategories).toHaveBeenCalledTimes(2);
});

// WHIT-204 — the shared helper ORs the queries' `.isLoading` (NOT `.isPending`) so an errored
// dependency shows its error, never an endless spinner. On a payCycle FAILURE the composite's
// isLoading must be FALSE. NOTE (WHIT-72): budgets no longer wait on payCycle (they fetch in
// parallel), so this scenario no longer exercises a DISABLED query — the direct `.isLoading`-
// vs-`.isPending` distinction is better locked by a dedicated useCombineScreenQueries unit
// test (tracked as a follow-up card). This still guards the payCycle-failure → not-stranded path.
it('useBudgetsScreenData: a payCycle failure does NOT strand isLoading', async () => {
  mockFetchPayCycle.mockReset().mockRejectedValue(new Error('API error: 503'));
  const { result } = renderHook(() => useBudgetsScreenData(), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(result.current.isLoading).toBe(false);
});

// Same lock for the budget-detail composite: a payCycle failure surfaces as isError, not a
// stranded spinner. (WHIT-72: budgets fetch in parallel here too; see the note above.)
it('useBudgetDetailScreenData: a payCycle failure surfaces as isError, not a stranded spinner', async () => {
  mockFetchPayCycle.mockReset().mockRejectedValue(new Error('API error: 503'));
  const { result } = renderHook(() => useBudgetDetailScreenData('coffee'), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(result.current.isError).toBe(true)); // payCycleQuery IS in the OR
  expect(result.current.isLoading).toBe(false);
});

// ===== WHIT-342 GAP (folded from categoryDrillQuery.gaps) — useCategoryCycleTransactionsQuery, the
// drill-in's data hook: no fetch before login (enabled=false), no fetch on empty categoryId, and the
// cycle is part of the query key so cycle 0 and cycle 1 for the same category cache INDEPENDENTLY.
// Own beforeEach seeds cycle-tagged rows (the module beforeEach doesn't touch this mock).
describe('useCategoryCycleTransactionsQuery (WHIT-342)', () => {
  beforeEach(() => {
    mockFetchCategoryTransactions.mockReset()
      // return rows tagged by the cycle asked for, so a key collision would surface as wrong rows.
      .mockImplementation((id, cycle) => Promise.resolve([{ transaction_id: `${id}-c${cycle}` }]));
  });

  // [A-hook1]
  it('does not fetch before login (enabled=false)', () => {
    renderHook(() => useCategoryCycleTransactionsQuery('coffee', 0, false), { wrapper: wrapper(makeClient()) });
    expect(mockFetchCategoryTransactions).not.toHaveBeenCalled();
  });

  // [A-hook2] — the `enabled && !!categoryId` guard: an absent id (a route mounted before params
  // resolve) must not fire a `/categories//transactions` request.
  it('does not fetch when categoryId is empty, even when enabled', () => {
    renderHook(() => useCategoryCycleTransactionsQuery('', 0, true), { wrapper: wrapper(makeClient()) });
    expect(mockFetchCategoryTransactions).not.toHaveBeenCalled();
  });

  // [A-hook4]
  it('fetches with (categoryId, cycle) when enabled and id present', async () => {
    const { result } = renderHook(() => useCategoryCycleTransactionsQuery('coffee', 1, true), { wrapper: wrapper(makeClient()) });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(mockFetchCategoryTransactions).toHaveBeenCalledWith('coffee', 1);
  });

  // [A-hook3] — the headline cache-key gap: cycle 0 and cycle 1 for the SAME category must not
  // collide. Both hooks share ONE client; each must resolve to ITS OWN cycle's rows.
  it('caches cycle 0 and cycle 1 independently for the same category (no collision)', async () => {
    const client = makeClient();
    const c0 = renderHook(() => useCategoryCycleTransactionsQuery('coffee', 0, true), { wrapper: wrapper(client) });
    const c1 = renderHook(() => useCategoryCycleTransactionsQuery('coffee', 1, true), { wrapper: wrapper(client) });

    await waitFor(() => expect(c0.result.current.data).toBeDefined());
    await waitFor(() => expect(c1.result.current.data).toBeDefined());

    expect(c0.result.current.data).toEqual([{ transaction_id: 'coffee-c0' }]);
    expect(c1.result.current.data).toEqual([{ transaction_id: 'coffee-c1' }]);
    // both cycles were actually fetched — a collided key would fetch once and share.
    expect(mockFetchCategoryTransactions).toHaveBeenCalledWith('coffee', 0);
    expect(mockFetchCategoryTransactions).toHaveBeenCalledWith('coffee', 1);
  });
});

// ===== WHIT-374 GAP (folded from categoryTransactionsScreenData.gaps) — useCategoryTransactionsScreenData,
// the drill-in composite that feeds `categoriesReady` to app/category/[id].tsx. Locks the warm/cold/
// empty/error/retry derivation of that flag from a real cache. Own consts (a DIFFERENT CATS/ROWS) +
// beforeEach block-scoped so they don't perturb the survivor's coffee fixture above.
describe('useCategoryTransactionsScreenData (WHIT-374)', () => {
  const CATS = [{ id: 'salary', name: 'Salary', bucket: 'Income', icon: 'briefcase', color: '#2ac3de', recent: 0 }];
  const ROWS = [{ transaction_id: 'salary-c0' }];

  beforeEach(() => {
    mockAuthStatus = 'authed';
    mockFetchCategories.mockReset().mockResolvedValue(CATS);
    mockFetchCategoryTransactions.mockReset().mockResolvedValue(ROWS);
  });

  // [A-warm] — the warm path: Insights already loaded the taxonomy, so drilling in must NOT flash a
  // spinner. Pre-seed the categories cache, then the FIRST synchronous render already has
  // categoriesReady === true. FAIL-ON-REVERT: hard-coding categoriesReady to false makes this fail.
  it('categoriesReady is true on the first render when the taxonomy is already cached', async () => {
    const client = makeClient();
    client.setQueryData(categoriesKey, CATS); // taxonomy warmed by an earlier screen
    const { result } = renderHook(() => useCategoryTransactionsScreenData('salary', 0), { wrapper: wrapper(client) });
    expect(result.current.categoriesReady).toBe(true);        // warm on mount → no cold gate
    expect(result.current.category('salary')?.bucket).toBe('Income');
    await waitFor(() => expect(result.current.transactions).toHaveLength(1)); // flush the txn fetch
  });

  // [A-cold] — the cold path the fix exists for: taxonomy in flight → categoriesReady false first
  // (the screen holds the spinner), then true once it lands. FAIL-ON-REVERT: hard-coding true skips
  // the false phase and this first assertion fails.
  it('categoriesReady is false while the taxonomy loads, then true once it lands', async () => {
    const { result } = renderHook(() => useCategoryTransactionsScreenData('salary', 0), { wrapper: wrapper(makeClient()) });
    expect(result.current.categoriesReady).toBe(false);       // cold: categories still fetching
    await waitFor(() => expect(result.current.categoriesReady).toBe(true));
  });

  // [A-empty] — an empty taxonomy is still "loaded" (data === []), so categoriesReady must be true
  // and the screen renders (everything Uncategorized), not stall on a spinner forever. No crash.
  it('treats an empty taxonomy ([]) as ready (true), not as never-loaded', async () => {
    mockFetchCategories.mockReset().mockResolvedValue([]);
    const { result } = renderHook(() => useCategoryTransactionsScreenData('salary', 0), { wrapper: wrapper(makeClient()) });
    await waitFor(() => expect(result.current.categoriesReady).toBe(true));
    expect(result.current.category('salary')).toBeUndefined(); // empty taxonomy → no match, no throw
  });

  // [A-err] — the categories-error-with-cached-transactions path: transactions resolve but the
  // taxonomy read fails. isError must be true and categoriesReady false, so the screen shows the
  // error card (it can't label/sign the rows) instead of a cold "$0" detail.
  it('a taxonomy read failure (transactions cached) surfaces isError with categoriesReady false', async () => {
    mockFetchCategories.mockReset().mockRejectedValue(new Error('API error: 500'));
    const { result } = renderHook(() => useCategoryTransactionsScreenData('salary', 0), { wrapper: wrapper(makeClient()) });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.categoriesReady).toBe(false);       // never loaded → screen must gate
    expect(result.current.transactions).toHaveLength(1);       // the txns DID land
    expect(result.current.isLoading).toBe(false);              // errored dep → not a stranded spinner
  });

  // [A-retry] — the inline Retry (refetch) must re-fire BOTH reads, so a taxonomy failure can
  // actually recover. FAIL-ON-REVERT: dropping categoriesQuery from useCombineScreenQueries' array
  // leaves fetchCategories at 1 call.
  it('refetch re-fires both the transactions and the categories reads', async () => {
    const { result } = renderHook(() => useCategoryTransactionsScreenData('salary', 0), { wrapper: wrapper(makeClient()) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(mockFetchCategoryTransactions).toHaveBeenCalledTimes(1);
    expect(mockFetchCategories).toHaveBeenCalledTimes(1);

    await act(async () => { result.current.refetch(); });
    await waitFor(() => expect(mockFetchCategoryTransactions).toHaveBeenCalledTimes(2));
    expect(mockFetchCategories).toHaveBeenCalledTimes(2);       // BOTH reads re-fired
  });
});
