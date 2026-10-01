// WHIT-627 QA — the lookup order and the "rules applied" refresh in src/transactionCache.ts, checked
// against a seeded cache by what it holds afterwards.
//   [A9]  every pair of copies de-dups to the fresher one: feed > uncategorized > recent > search >
//         budget > category.
//   [A10] an empty cache, and a search entry with no data yet, read as nothing (never throw).
//   [A11] findTransaction honours includeScopedLists (a budget-only charge is invisible to writers).
//   [A12] refreshAfter('rulesApplied') trims the uncategorized feed to page 1 and marks its set.
//   [A13] refreshAfter('rulesApplied', { skipRules: true }) leaves the rules list alone.
import { it, expect, describe, beforeEach, afterEach } from '@jest/globals';
import type { QueryKey } from '@tanstack/react-query';
import { makeQueryClient, queryClient } from '../queryClient';
import { readTransactionCopies, findTransaction, refreshAfter } from '../transactionCache';
import type { Transaction } from '../types';

const tx = (id: string, category: string): Transaction => ({
  transaction_id: id, date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'COLES', merchant_name: 'Coles', amount: -12.5, account_id: 'a1',
  account_name: 'ANZ', category, status: 'posted', type: 'PAYMENT', counts_to_budget: true,
});
const page = (transactions: Transaction[]) => ({ pages: [{ transactions, nextCursor: null }], pageParams: [undefined] });

// Clear every cache after each case so no 5-minute cleanup timer keeps Jest running.
const clients: ReturnType<typeof makeQueryClient>[] = [];
function freshClient() {
  const client = makeQueryClient();
  clients.push(client);
  return client;
}
afterEach(() => {
  clients.splice(0).forEach((client) => client.clear());
  queryClient.clear();
});

type Source = { name: string; seed: (client: ReturnType<typeof makeQueryClient>, row: Transaction) => void };
const SOURCES: Source[] = [
  { name: 'feed', seed: (c, row) => c.setQueryData(['transactions'], page([row])) },
  { name: 'uncategorized', seed: (c, row) => c.setQueryData(['uncategorizedFeed'], page([row])) },
  { name: 'recent', seed: (c, row) => c.setQueryData(['transactionsRecent'], [row]) },
  { name: 'search', seed: (c, row) => c.setQueryData(['transactionsSearch', 'all', 'x'], { transactions: [row], truncated: false }) },
  { name: 'budget', seed: (c, row) => c.setQueryData(['budgetTransactions', 'b1'], [row]) },
  { name: 'category', seed: (c, row) => c.setQueryData(['categoryTransactions', 'c1', 0], [row]) },
];

describe('readTransactionCopies', () => {
  // [A9]
  const pairs = SOURCES.flatMap((fresher, i) => SOURCES.slice(i + 1).map((staler) => [fresher, staler] as const));
  it.each(pairs.map(([a, b]) => [a.name, b.name, a, b]))('%s wins over %s', (_a, _b, fresher, staler) => {
    const client = freshClient();
    (staler as Source).seed(client, tx('shared', 'stale'));
    (fresher as Source).seed(client, tx('shared', 'fresh'));
    const rows = readTransactionCopies(client, { includeScopedLists: true });
    expect(rows.map((t) => [t.transaction_id, t.category])).toEqual([['shared', 'fresh']]);
  });

  // [A10]
  it('reads an empty cache and a data-less search entry as nothing', () => {
    const client = freshClient();
    expect(readTransactionCopies(client, { includeScopedLists: true })).toEqual([]);
    client.setQueryData(['transactionsSearch', 'all', 'x'], undefined);
    client.getQueryCache().build(client, { queryKey: ['transactionsSearch', 'all', 'pending'] });
    client.getQueryCache().build(client, { queryKey: ['budgetTransactions', 'pending'] });
    expect(readTransactionCopies(client, { includeScopedLists: true })).toEqual([]);
  });
});

describe('findTransaction (the singleton cache)', () => {
  beforeEach(() => { queryClient.clear(); });

  // [A11]
  it('sees a budget-only or category-only charge only when scoped lists are included', () => {
    queryClient.setQueryData(['budgetTransactions', 'b1'], [tx('budgetOnly', 'dining')]);
    queryClient.setQueryData(['categoryTransactions', 'c1', 0], [tx('categoryOnly', 'dining')]);
    expect(findTransaction('budgetOnly', { includeScopedLists: false })).toBeUndefined();
    expect(findTransaction('categoryOnly', { includeScopedLists: false })).toBeUndefined();
    expect(findTransaction('budgetOnly', { includeScopedLists: true })?.category).toBe('dining');
    expect(findTransaction('categoryOnly', { includeScopedLists: true })?.category).toBe('dining');
    expect(findTransaction('missing', { includeScopedLists: true })).toBeUndefined();
  });
});

describe("refreshAfter('rulesApplied')", () => {
  const RULES_APPLIED_SET: QueryKey[] = [
    ['budgets', 14], ['breakdown', 14, 0], ['budgetTransactions', 'b1'], ['categoryTransactions', 'c1', 0],
    ['uncategorizedCount'], ['uncategorizedFeed'], ['transactionsSearch', 'all', 'x'], ['categories'],
    ['rules'], ['uncategorizedMerchants'], ['filingSuggestions'],
  ];
  const invalidated = (key: QueryKey) => queryClient.getQueryState(key)?.isInvalidated;

  function seed() {
    for (const key of RULES_APPLIED_SET) queryClient.setQueryData(key, key[0] === 'uncategorizedFeed' ? undefined : []);
    queryClient.setQueryData(['uncategorizedFeed'], {
      pages: [{ transactions: [tx('p1', 'x')], nextCursor: 'c2' }, { transactions: [tx('p2', 'x')], nextCursor: null }],
      pageParams: [undefined, 'c2'],
    });
    queryClient.setQueryData(['transactions'], page([tx('f1', 'x')]));
    queryClient.setQueryData(['transactionsRecent'], [tx('r1', 'x')]);
    queryClient.setQueryData(['payCycle'], {});
  }
  beforeEach(() => { queryClient.clear(); seed(); });

  // [A12]
  it('trims the uncategorized feed to page 1 and marks every server-derived list, not the feed', () => {
    refreshAfter('rulesApplied');
    const feed = queryClient.getQueryData<{ pages: unknown[]; pageParams: unknown[] }>(['uncategorizedFeed']);
    expect(feed?.pages).toHaveLength(1);
    expect(feed?.pageParams).toEqual([undefined]);
    for (const key of RULES_APPLIED_SET) expect([key, invalidated(key)]).toEqual([key, true]);
    expect(invalidated(['transactions'])).toBe(false);
    expect(invalidated(['transactionsRecent'])).toBe(false);
    expect(invalidated(['payCycle'])).toBe(false);
  });

  // [A13]
  it('skipRules leaves only the rules list unmarked', () => {
    refreshAfter('rulesApplied', { skipRules: true });
    expect(invalidated(['rules'])).toBe(false);
    for (const key of RULES_APPLIED_SET.filter((k) => k[0] !== 'rules')) {
      expect([key, invalidated(key)]).toEqual([key, true]);
    }
  });
});
