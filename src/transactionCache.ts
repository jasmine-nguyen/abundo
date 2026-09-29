// WHIT-627: the one place that knows every saved copy of a charge. A charge can sit in up to six
// query caches at once:
//   ['transactions']            the Transactions tab feed (InfiniteData, the "Load More" history)
//   ['uncategorizedFeed']       the Uncategorized tab's own paged feed
//   ['transactionsRecent']      the bounded recent window (tab-bar dot, account-detail, goal-edit)
//   ['transactionsSearch', *]   the Transactions-tab search results (WHIT-576)
//   ['budgetTransactions', *]   budget-detail cycle lists
//   ['categoryTransactions', *] Insights category drill-in lists
// The first four are the "main" copies. The last two are "scoped" lists, keyed per category and
// cycle: a re-file never reads or stamps them (WHIT-524 — a stale cycle-keyed row must not join a
// re-file sweep); it drops rows from the old budget's list and lets the refresh rebuild them.
// Lookups (a tapped charge that lives only in a budget list) do read them.
//
// No runtime imports from './context' or './queries': queries.ts imports context.tsx, and both
// import this module, so a runtime import back would be circular.
import type { InfiniteData, QueryClient, QueryKey } from '@tanstack/react-query';
import { queryClient } from './queryClient';
import type { TransactionFeedPage, TransactionSearchResult } from './api';
import type { Transaction, Category } from './context';

// Concatenate transaction lists, keeping the FIRST copy of each id — so callers list their
// freshest source first.
export function unionById(lists: Transaction[][]): Transaction[] {
  const seen = new Set<string>();
  const merged: Transaction[] = [];
  for (const list of lists) {
    for (const transaction of list) {
      if (seen.has(transaction.transaction_id)) continue;
      seen.add(transaction.transaction_id);
      merged.push(transaction);
    }
  }
  return merged;
}

function readFeedRows(client: QueryClient, key: QueryKey): Transaction[] {
  const data = client.getQueryData<InfiniteData<TransactionFeedPage>>(key);
  return data ? data.pages.flatMap((p) => p.transactions) : [];
}

function readScopedRows(client: QueryClient, prefix: QueryKey): Transaction[][] {
  return client.getQueriesData<Transaction[]>({ queryKey: prefix }).map(([, rows]) => rows ?? []);
}

// Every copy of every charge, de-duped by id. Freshest first so it wins the de-dup: feed →
// uncategorized feed → recent → search, then (only when asked) budget → category lists.
// Writers pass includeScopedLists: false; lookups pass true (WHIT-524, see the header).
export function readTransactionCopies(
  client: QueryClient, { includeScopedLists }: { includeScopedLists: boolean },
): Transaction[] {
  const lists = [
    readFeedRows(client, ['transactions']),
    readFeedRows(client, ['uncategorizedFeed']),
    client.getQueryData<Transaction[]>(['transactionsRecent']) ?? [],
    ...client.getQueriesData<TransactionSearchResult>({ queryKey: ['transactionsSearch'] })
      .map(([, result]) => result?.transactions ?? []),
  ];
  if (includeScopedLists) {
    lists.push(...readScopedRows(client, ['budgetTransactions']), ...readScopedRows(client, ['categoryTransactions']));
  }
  return unionById(lists);
}

export function findTransaction(id: string, opts: { includeScopedLists: boolean }): Transaction | undefined {
  return readTransactionCopies(queryClient, opts).find((t) => t.transaction_id === id);
}

// Map the caller's per-row transform over the feed pages, the uncategorized-feed pages (page
// boundaries + cursors preserved) AND the flat recent array, so an optimistic edit reflects on the
// tab list, the uncategorized tab, the dot, account-detail, and goal-edit at once.
// On the uncategorized tab this is what drops a just-filed
// row from the list instantly: the row stays in the cached page but no longer matches the client
// re-filter, so it disappears without a whole-history re-scan.
// Most callers are a plain .map() that adds and removes no rows. The exception is WHIT-508's
// apply-rules reconcile, which also REMOVES rows the server reported as deleted mid-run: safe
// because page boundaries and cursors are untouched and the feeds already tolerate a sparse or
// empty page (see useUncategorizedFeedQuery).
function patchInfiniteFeed(key: QueryKey, fn: (prev: Transaction[]) => Transaction[]): void {
  queryClient.setQueryData<InfiniteData<TransactionFeedPage>>(key, (prev) =>
    prev ? { ...prev, pages: prev.pages.map((pg) => ({ ...pg, transactions: fn(pg.transactions) })) } : prev);
}

// Patch the main copies (feed, uncategorized feed, recent, search). Guarded: no-ops on a cleared
// cache, so a late rollback after sign-out needs no epoch gate.
export function patchTransactionsCache(fn: (prev: Transaction[]) => Transaction[]): void {
  patchInfiniteFeed(['transactions'], fn);
  patchInfiniteFeed(['uncategorizedFeed'], fn);
  queryClient.setQueryData<Transaction[]>(['transactionsRecent'], (prev) => (prev ? fn(prev) : prev));
  queryClient.setQueriesData<TransactionSearchResult>({ queryKey: ['transactionsSearch'] }, (prev) =>
    prev ? { ...prev, transactions: fn(prev.transactions) } : prev);
}

function patchScopedLists(mapRow: (row: Transaction) => Transaction): void {
  for (const prefix of [['budgetTransactions'], ['categoryTransactions']]) {
    for (const [key] of queryClient.getQueriesData<Transaction[]>({ queryKey: prefix })) {
      queryClient.setQueryData<Transaction[]>(key, (prev) => (prev ? prev.map(mapRow) : prev));
    }
  }
}

// Stamp a row transform onto every copy, main and scoped (a note/tag/exclude edit, not a re-file).
export function patchAllCopies(mapRow: (row: Transaction) => Transaction): void {
  patchTransactionsCache((prev) => prev.map(mapRow));
  patchScopedLists(mapRow);
}

// What to mark for a refresh after each kind of change. The feed is never here: it is an
// InfiniteData of loaded pages, so invalidating it would refetch every page (a storm); the
// optimistic patch already wrote the change into it.
const REFRESH_BY_CHANGE: Record<'refile' | 'budgetExclusion' | 'categoryDeleted' | 'rulesApplied', QueryKey[]> = {
  // A re-file changes the totals, which budget/category list a charge belongs to, and the
  // uncategorized tally (WHIT-501). Search is patched in place, so it is skipped.
  refile: [['budgets'], ['breakdown'], ['budgetTransactions'], ['categoryTransactions'], ['uncategorizedCount']],
  // Excluding/including a charge changes the budget total and its cycle list; not the tally.
  budgetExclusion: [['budgets'], ['breakdown'], ['budgetTransactions'], ['categoryTransactions']],
  // The deleted category's charges become unfiled: they must ENTER the uncategorized feed and
  // search results, which an in-place patch can't do. Budgets are cascaded by hand (a refetch
  // would resurrect the dropped budget, as the server doesn't cascade). The charge lists reload so
  // a charge leaves a parent budget's list and the spend moves; their refetched rows still carry
  // the dangling id, which shows as Uncategorized through categoryIsUnmapped.
  categoryDeleted: [
    ['breakdown'], ['uncategorizedCount'], ['uncategorizedFeed'], ['transactionsSearch'],
    ['budgetTransactions'], ['categoryTransactions'],
  ],
  // A server-side run can file rows we never saw, move them into or out of search, mint rules
  // (WHIT-517), shrink the shop groups and suggestions (WHIT-542), and file under a category
  // created in another session — so re-read the taxonomy too.
  rulesApplied: [
    ['budgets'], ['breakdown'], ['budgetTransactions'], ['categoryTransactions'], ['uncategorizedCount'],
    ['uncategorizedFeed'], ['transactionsSearch'], ['categories'], ['rules'], ['uncategorizedMerchants'],
    ['filingSuggestions'],
  ],
};

export type ChangeKind = keyof typeof REFRESH_BY_CHANGE;

// `skipRules` leaves ['rules'] alone: WHIT-538's new-rule filing shows its minted rule optimistically
// with a "NEW" badge that a refetch would reset.
export function refreshAfter(kind: ChangeKind, opts?: { skipRules?: boolean }): void {
  if (kind === 'rulesApplied') {
    // Trim the uncategorized feed to page 1 BEFORE invalidating, so the refetch is one round trip
    // rather than every loaded page, while page 1 stays on screen (WHIT-508).
    queryClient.setQueryData<InfiniteData<TransactionFeedPage>>(['uncategorizedFeed'], (prev) =>
      prev && prev.pages.length > 1
        ? { ...prev, pages: prev.pages.slice(0, 1), pageParams: prev.pageParams.slice(0, 1) }
        : prev);
  }
  for (const queryKey of REFRESH_BY_CHANGE[kind]) {
    if (opts?.skipRules && queryKey[0] === 'rules') continue;
    queryClient.invalidateQueries({ queryKey });
  }
}

// Does the budget on `budgetId` own `categoryId`? — the client mirror of the server's
// subtree_ids (shared/spend.py): a budget's spend is its own category id PLUS every descendant
// in the SAME bucket. The descent passes THROUGH a cross-bucket intermediate to reach a
// same-bucket descendant, so only the two ENDPOINTS' buckets matter, not the nodes between. In a
// single-parent tree, walking UP the `parent` chain from categoryId and reaching budgetId proves
// categoryId is a descendant; we then keep it iff it is the root itself or shares the root's
// bucket (an absent category's bucket is `undefined`, mirroring the server's `None == None`).
// Cycle-safe via `seen`. Pinned to the server rule by the shared-fixture parity test
// (budgetSubtreeParity) so the two can't silently drift.
export function budgetSubtreeContains(categories: Category[], budgetId: string, categoryId: string): boolean {
  if (categoryId === budgetId) return true; // the root is always in its own subtree
  const byId = new Map(categories.map((c) => [c.id, c]));
  const seen = new Set<string>();
  let cur = byId.get(categoryId)?.parent ?? null;
  while (cur && !seen.has(cur)) {
    if (cur === budgetId) return byId.get(categoryId)?.bucket === byId.get(budgetId)?.bucket;
    seen.add(cur);
    cur = byId.get(cur)?.parent ?? null;
  }
  return false; // categoryId is not a descendant of budgetId (an orphan/unknown id that isn't the root)
}

// WHIT-348: drop the given re-filed tx ids from every cached ['budgetTransactions', budgetId]
// list whose budget no longer owns their NEW category, so a re-file disappears from the old
// budget's detail list instantly (mirrors WHIT-344's exclude removal). Removal only — a charge
// re-filed INTO a budget is added back by the invalidate refetch, which owns the window + sort.
// Only rewrites a list that actually shrank (skips lists the id was never in). Returns the prior
// snapshots of ONLY the lists it changed, so a failed save rolls back exactly those (WHIT-360) —
// restoring untouched lists would clobber a concurrent refetch of an unrelated budget.
function removeRefiledFromBudgetLists(categories: Category[], ids: string[], newCategoryId: string) {
  const snapshots = queryClient.getQueriesData<Transaction[]>({ queryKey: ['budgetTransactions'] });
  const changed: typeof snapshots = [];
  snapshots.forEach(([key, data]) => {
    if (!data) return;
    const budgetId = key[1] as string;
    if (budgetSubtreeContains(categories, budgetId, newCategoryId)) return; // still owned by this budget
    const next = data.filter((t) => !ids.includes(t.transaction_id));
    if (next.length === data.length) return; // the id was never in this list — leave it untouched
    changed.push([key, data]);
    queryClient.setQueryData<Transaction[]>(key, next);
  });
  return changed;
}

// Optimistically file `ids` under `categoryId` on every main copy and drop them from any budget
// list that no longer owns them. Returns a rollback for the ids whose save failed: each goes
// back to its OWN previous category (WHIT-324), never a blanket Uncategorized. The budget-list
// restore uses raw setQueryData, which would recreate a cleared entry after sign-out, so it only
// runs while `epochStillCurrent()`; it restores the snapshots then re-drops the ids that saved.
export function optimisticRefile(
  ids: string[], categoryId: string, categories: Category[], epochStillCurrent: () => boolean,
): (failedIds: string[]) => void {
  const previousById = new Map(
    readTransactionCopies(queryClient, { includeScopedLists: false })
      .filter((t) => ids.includes(t.transaction_id))
      .map((t) => [t.transaction_id, t.category] as const),
  );
  patchTransactionsCache((prev) =>
    prev.map((existing) => (ids.includes(existing.transaction_id) ? { ...existing, category: categoryId } : existing)));
  const budgetTxSnaps = removeRefiledFromBudgetLists(categories, ids, categoryId);

  return (failedIds) => {
    if (failedIds.length === 0) return;
    patchTransactionsCache((prev) =>
      prev.map((existing) => (failedIds.includes(existing.transaction_id)
        ? { ...existing, category: previousById.get(existing.transaction_id) ?? null }
        : existing)));
    if (!epochStillCurrent()) return;
    budgetTxSnaps.forEach(([key, data]) => queryClient.setQueryData(key, data));
    const savedIds = ids.filter((id) => !failedIds.includes(id));
    if (savedIds.length > 0) removeRefiledFromBudgetLists(categories, savedIds, categoryId);
  };
}
