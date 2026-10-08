// WHIT-627 — the one place that knows every saved copy of a charge. readTransactionCopies reads
// the feed, uncategorized feed, recent window and search results, then (only when asked) the
// budget and category lists. Writers pass includeScopedLists:false (WHIT-524); lookups pass true.
// Freshest copies come first so they win the de-dup over a stale budget/category copy.
import { it, expect, describe } from '@jest/globals';
import { makeQueryClient } from '../queryClient';
import { readTransactionCopies } from '../transactionCache';
import type { Transaction } from '../types';
import { colesTxn } from './factory';

const tx = (id: string, over: Partial<Transaction> = {}) => colesTxn({ transaction_id: id, ...over });
const ids = (list: Transaction[]) => list.map((t) => t.transaction_id);

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
});
