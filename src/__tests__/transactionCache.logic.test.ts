// WHIT-627 — the one place that knows every saved copy of a charge. readTransactionCopies reads
// the feed, uncategorized feed, recent window and search results, then (only when asked) the
// budget and category lists. Writers pass includeScopedLists:false (WHIT-524); lookups pass true.
// Freshest copies come first so they win the de-dup over a stale budget/category copy.
import { it, expect, describe, beforeEach, afterEach } from '@jest/globals';
import type { QueryKey } from '@tanstack/react-query';
import { makeQueryClient, queryClient } from '../queryClient';
import { readTransactionCopies, findTransaction, refreshAfter } from '../transactionCache';
import type { Transaction } from '../types';
import { colesTxn } from './factory';
import { seedTransactionsCache } from './support/transactionsCache';

const tx = (id: string, over: Partial<Transaction> = {}) => colesTxn({ transaction_id: id, ...over });
const ids = (list: Transaction[]) => list.map((t) => t.transaction_id);

// Clear the singleton after each case so no 5-minute cleanup timer keeps Jest running.
afterEach(() => { queryClient.clear(); });

function seededClient() {
  const client = makeQueryClient();
  client.setQueryData(['transactions'], {
    pages: [{ transactions: [tx('shared', { category: 'groceries' }), tx('feed1')], nextCursor: null }],
    pageParams: [undefined],
  });
  client.setQueryData(['uncategorizedFeed'], {
    pages: [{ transactions: [tx('uncat1')], nextCursor: null }],
    pageParams: [undefined],
  });
  client.setQueryData(['transactionsRecent'], [tx('recent1')]);
  client.setQueryData(['transactionsSearch', 'all', 'coles'], { transactions: [tx('search1')], truncated: false });
  client.setQueryData(['budgetTransactions', 'dining'], [tx('shared', { category: 'dining' }), tx('budget1')]);
  client.setQueryData(['categoryTransactions', 'dining', 0], [tx('category1')]);
  return client;
}

describe('readTransactionCopies', () => {
  it('lookups see every list with the freshest copy winning; writers skip the budget and category lists', () => {
    const client = seededClient();

    const lookup = readTransactionCopies(client, { includeScopedLists: true });
    expect(ids(lookup)).toEqual(['shared', 'feed1', 'uncat1', 'recent1', 'search1', 'budget1', 'category1']);
    expect(lookup.find((t) => t.transaction_id === 'shared')?.category).toBe('groceries');

    const writer = readTransactionCopies(client, { includeScopedLists: false });
    expect(ids(writer)).toEqual(['shared', 'feed1', 'uncat1', 'recent1', 'search1']);
  });

  it('reads an empty cache and a data-less search entry as nothing', () => {
    const client = makeQueryClient();
    expect(readTransactionCopies(client, { includeScopedLists: true })).toEqual([]);
    client.setQueryData(['transactionsSearch', 'all', 'x'], undefined);
    client.getQueryCache().build(client, { queryKey: ['transactionsSearch', 'all', 'pending'] });
    client.getQueryCache().build(client, { queryKey: ['budgetTransactions', 'pending'] });
    expect(readTransactionCopies(client, { includeScopedLists: true })).toEqual([]);
    client.clear();
  });
});

describe('findTransaction (the singleton cache)', () => {
  it('sees a budget-only or category-only charge only when scoped lists are included', () => {
    queryClient.setQueryData(['budgetTransactions', 'b1'], [tx('budgetOnly', { category: 'dining' })]);
    queryClient.setQueryData(['categoryTransactions', 'c1', 0], [tx('categoryOnly', { category: 'dining' })]);
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

  beforeEach(() => {
    for (const key of RULES_APPLIED_SET) queryClient.setQueryData(key, key[0] === 'uncategorizedFeed' ? undefined : []);
    queryClient.setQueryData(['uncategorizedFeed'], {
      pages: [{ transactions: [tx('p1')], nextCursor: 'c2' }, { transactions: [tx('p2')], nextCursor: null }],
      pageParams: [undefined, 'c2'],
    });
    seedTransactionsCache(queryClient, [tx('f1')]);
    queryClient.setQueryData(['transactionsRecent'], [tx('r1')]);
    queryClient.setQueryData(['payCycle'], {});
  });

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

  it('skipRules leaves only the rules list unmarked', () => {
    refreshAfter('rulesApplied', { skipRules: true });
    expect(invalidated(['rules'])).toBe(false);
    for (const key of RULES_APPLIED_SET.filter((k) => k[0] !== 'rules')) {
      expect([key, invalidated(key)]).toEqual([key, true]);
    }
  });
});
