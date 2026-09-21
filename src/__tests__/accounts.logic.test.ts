// WHIT-215 — the Accounts tab + per-account detail derive ENTIRELY from the transaction
// list (no separate accounts feed). These lock the two pure selectors: accountSummaries
// (one row per account_id, one canonical name, busiest-first) and accountDetail (this
// account's transactions, grouped; null for an unknown id).
import { describe, it, expect } from '@jest/globals';
import { accountSummaries, accountDetail } from '../context';
import { txn } from './factory';

const category = (_id: string | null) => undefined;

describe('accountSummaries', () => {
  it('collapses to one row per account_id with the right transaction count', () => {
    const out = accountSummaries({
      transactions: [
        txn({ transaction_id: 't1', account_id: 'a1', account_name: 'ANZ' }),
        txn({ transaction_id: 't2', account_id: 'a1', account_name: 'ANZ' }),
        txn({ transaction_id: 't3', account_id: 'a2', account_name: 'Up Homeloan' }),
      ],
    });
    expect(out).toEqual([
      { id: 'a1', name: 'ANZ', count: 2 },
      { id: 'a2', name: 'Up Homeloan', count: 1 },
    ]);
  });

  it('picks ONE canonical name per account — the most frequent account_name spelling', () => {
    const out = accountSummaries({
      transactions: [
        txn({ transaction_id: 't1', account_id: 'a1', account_name: 'Up Homeloan' }),
        txn({ transaction_id: 't2', account_id: 'a1', account_name: 'Up Homeloan' }),
        txn({ transaction_id: 't3', account_id: 'a1', account_name: 'UP HOME LOAN' }),
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('Up Homeloan');
  });

  it('ignores blank names and falls back to the id when every name is blank', () => {
    const out = accountSummaries({
      transactions: [
        txn({ transaction_id: 't1', account_id: 'a9', account_name: '   ' }),
        txn({ transaction_id: 't2', account_id: 'a9', account_name: '' }),
      ],
    });
    expect(out[0]).toEqual({ id: 'a9', name: 'a9', count: 2 });
  });

  it('sorts busiest account first', () => {
    const out = accountSummaries({
      transactions: [
        txn({ transaction_id: 't1', account_id: 'small', account_name: 'Small' }),
        txn({ transaction_id: 't2', account_id: 'big', account_name: 'Big' }),
        txn({ transaction_id: 't3', account_id: 'big', account_name: 'Big' }),
      ],
    });
    expect(out.map((a) => a.id)).toEqual(['big', 'small']);
  });

  it('is empty when there are no transactions', () => {
    expect(accountSummaries({ transactions: [] })).toEqual([]);
  });
});

describe('accountDetail', () => {
  const transactions = [
    txn({ transaction_id: 't1', account_id: 'a1', account_name: 'ANZ' }),
    txn({ transaction_id: 't2', account_id: 'a2', account_name: 'Up Homeloan' }),
    txn({ transaction_id: 't3', account_id: 'a1', account_name: 'ANZ' }),
  ];

  it('returns only the requested account\'s transactions, grouped, with its canonical name', () => {
    const d = accountDetail({ transactions, category }, 'a1');
    expect(d).not.toBeNull();
    expect(d!.name).toBe('ANZ');
    expect(d!.count).toBe(2);
    const ids = d!.groups.flatMap((g) => g.items.map((t) => t.transaction_id));
    expect(ids.sort()).toEqual(['t1', 't3']);
  });

  it('returns null for an account_id no transaction carries (unknown / stale deep-link)', () => {
    expect(accountDetail({ transactions, category }, 'nope')).toBeNull();
  });
});
