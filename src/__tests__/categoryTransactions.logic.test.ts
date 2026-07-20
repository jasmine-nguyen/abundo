// WHIT-308: categoryTransactions — the transactions behind an Insights spend row, for the
// selected cycle, with a total that reconciles to the /breakdown card. Pure over
// { transactions, category }, so it runs headlessly via makeState.
import { describe, it, expect } from '@jest/globals';
import { categoryTransactions, categoryBreakdown, UNCATEGORIZED_KEY } from '../context';
import { makeState, cat, txn, spend } from './factory';

const cats = [
  cat({ id: 'coffee', name: 'Cafes & Coffee', bucket: 'Lifestyle' }),
  cat({ id: 'groceries', name: 'Groceries', bucket: 'Living' }),
];
// A wide-open window so date filtering isn't in the way unless a test sets a date outside it.
const OPEN = { start: '2026-01-01', end: '2026-12-31' };

describe('categoryTransactions', () => {
  it('lists a named category’s transactions in-window and totals the spend', () => {
    const s = makeState({
      categories: cats,
      transactions: [
        txn({ transaction_id: 'c1', category: 'coffee', amount: -20, status: 'posted', date: '2026-06-10' }),
        txn({ transaction_id: 'c2', category: 'coffee', amount: -5, status: 'pending', date: '2026-06-11' }),
        txn({ transaction_id: 'g1', category: 'groceries', amount: -80, status: 'posted', date: '2026-06-10' }),
      ],
    });
    const detail = categoryTransactions(s, 'coffee', OPEN)!;
    expect(detail.name).toBe('Cafes & Coffee');
    expect(detail.count).toBe(2);
    expect(detail.total).toBe(25);
    expect(detail.pending).toBe(5);
    expect(detail.posted).toBe(20);
    // grouped by date, only coffee rows
    expect(detail.groups.flatMap((g) => g.items.map((t) => t.transaction_id)).sort()).toEqual(['c1', 'c2']);
  });

  // FAIL-ON-REVERT for the critic's MAJOR finding #2: posted and pending clamp INDEPENDENTLY
  // (mirroring shared/spend.py _summarise), not as one aggregate. A refund that drives the
  // posted bucket net-negative clamps that bucket to 0 without eating into pending.
  it('clamps posted and pending buckets separately, not the aggregate', () => {
    const s = makeState({
      categories: cats,
      transactions: [
        txn({ transaction_id: 'p1', category: 'coffee', amount: -10, status: 'posted', date: '2026-06-10' }),
        txn({ transaction_id: 'r1', category: 'coffee', amount: 15, status: 'posted', date: '2026-06-11' }), // refund
        txn({ transaction_id: 'q1', category: 'coffee', amount: -25, status: 'pending', date: '2026-06-12' }),
      ],
    });
    const detail = categoryTransactions(s, 'coffee', OPEN)!;
    // posted = max(0, 10 - 15) = 0; pending = 25 → total 25. An aggregate clamp would give 20.
    expect(detail.posted).toBe(0);
    expect(detail.pending).toBe(25);
    expect(detail.total).toBe(25);
  });

  it('shows every named-category row (refunds + budget-excluded) but only counts contributors in the total', () => {
    const s = makeState({
      categories: cats,
      transactions: [
        txn({ transaction_id: 'c1', category: 'coffee', amount: -20, status: 'posted', date: '2026-06-10' }),
        txn({ transaction_id: 'x1', category: 'coffee', amount: -12, status: 'posted', date: '2026-06-11', budget_excluded: true }),
      ],
    });
    const detail = categoryTransactions(s, 'coffee', OPEN)!;
    expect(detail.count).toBe(2);       // the excluded row is still LISTED (like accountDetail)
    expect(detail.total).toBe(20);      // ...but it doesn't add to the total
  });

  it('Uncategorized lists budget-contributing unmapped spend and excludes income + mapped + excluded', () => {
    const s = makeState({
      categories: cats,
      transactions: [
        txn({ transaction_id: 'u1', category: null, amount: -30, status: 'posted', date: '2026-06-10' }),
        txn({ transaction_id: 'u2', category: 'RAW_ENUM', amount: -8, status: 'pending', date: '2026-06-11' }), // unknown id
        txn({ transaction_id: 'inc', category: 'income', amount: 500, status: 'posted', date: '2026-06-10' }), // income sentinel
        txn({ transaction_id: 'map', category: 'coffee', amount: -20, status: 'posted', date: '2026-06-10' }), // mapped
        txn({ transaction_id: 'exc', category: null, amount: -40, status: 'posted', date: '2026-06-10', budget_excluded: true }),
      ],
    });
    const detail = categoryTransactions(s, UNCATEGORIZED_KEY, OPEN)!;
    expect(detail.name).toBe('Uncategorized');
    expect(detail.groups.flatMap((g) => g.items.map((t) => t.transaction_id)).sort()).toEqual(['u1', 'u2']);
    expect(detail.total).toBe(38); // 30 posted + 8 pending
  });

  it('filters to the window, inclusive on both ends', () => {
    const s = makeState({
      categories: cats,
      transactions: [
        txn({ transaction_id: 'before', category: 'coffee', amount: -10, status: 'posted', date: '2026-06-05' }),
        txn({ transaction_id: 'start', category: 'coffee', amount: -10, status: 'posted', date: '2026-06-06' }),
        txn({ transaction_id: 'end', category: 'coffee', amount: -10, status: 'posted', date: '2026-06-19' }),
        txn({ transaction_id: 'after', category: 'coffee', amount: -10, status: 'posted', date: '2026-06-20' }),
      ],
    });
    const detail = categoryTransactions(s, 'coffee', { start: '2026-06-06', end: '2026-06-19' })!;
    expect(detail.groups.flatMap((g) => g.items.map((t) => t.transaction_id)).sort()).toEqual(['end', 'start']);
    expect(detail.total).toBe(20);
  });

  it('returns null for a valid id with no transactions in the window (empty state, not loading)', () => {
    const s = makeState({
      categories: cats,
      transactions: [txn({ category: 'coffee', amount: -10, status: 'posted', date: '2026-01-05' })],
    });
    expect(categoryTransactions(s, 'coffee', { start: '2026-06-01', end: '2026-06-30' })).toBeNull();
    expect(categoryTransactions(s, 'groceries', OPEN)).toBeNull();
  });

  // The card's real acceptance test: over ONE shared fixture, the drilled total equals the
  // categoryBreakdown row it came from — for a leaf, a "Directly in X" (parent) row, and
  // Uncategorized. (breakdown + transactions are independent caches in the app; here they
  // come from the same fixture so the two client code paths must agree.)
  it('reconciles the drilled total with the categoryBreakdown row', () => {
    const treeCats = [
      cat({ id: 'food', name: 'Food', bucket: 'Living' }),
      cat({ id: 'coffee', name: 'Coffee', bucket: 'Living', parent: 'food' }),
    ];
    const transactions = [
      txn({ transaction_id: 'f1', category: 'food', amount: -30, status: 'posted', date: '2026-06-10' }),   // directly in Food
      txn({ transaction_id: 'c1', category: 'coffee', amount: -20, status: 'posted', date: '2026-06-11' }),
      txn({ transaction_id: 'c2', category: 'coffee', amount: -5, status: 'pending', date: '2026-06-12' }),
      txn({ transaction_id: 'u1', category: null, amount: -14, status: 'posted', date: '2026-06-10' }),
    ];
    // The server /breakdown map the same fixture would produce (per-id, per-bucket, clamped).
    const breakdown = {
      food: spend({ posted: 30, pending: 0 }),
      coffee: spend({ posted: 20, pending: 5 }),
      [UNCATEGORIZED_KEY]: spend({ posted: 14, pending: 0 }),
    };
    const s = makeState({ categories: treeCats, transactions, breakdown });
    const { rows } = categoryBreakdown({ breakdown, category: s.category });

    for (const row of rows) {
      if (row.hasChildren) continue; // parent rows expand, not drill
      const detail = categoryTransactions(s, row.drillId, OPEN);
      expect(detail).not.toBeNull();
      expect(detail!.total).toBe(row.spent);
    }
    // and specifically the "Directly in Food" row drills into the parent id, matching its own spend
    const direct = rows.find((r) => r.id === 'food__direct')!;
    expect(direct.drillId).toBe('food');
    expect(categoryTransactions(s, direct.drillId, OPEN)!.total).toBe(30);
  });
});

describe('categoryBreakdown drillId', () => {
  it('sets drillId to the row’s own id for a leaf and Uncategorized, and to the parent for a "Directly in X" row', () => {
    const treeCats = [
      cat({ id: 'food', name: 'Food', bucket: 'Living' }),
      cat({ id: 'coffee', name: 'Coffee', bucket: 'Living', parent: 'food' }),
    ];
    const breakdown = {
      food: spend({ posted: 30, pending: 0 }),   // direct-in-parent → forces a __direct row
      coffee: spend({ posted: 20, pending: 0 }),
      [UNCATEGORIZED_KEY]: spend({ posted: 14, pending: 0 }),
    };
    const s = makeState({ categories: treeCats, breakdown });
    const rows = categoryBreakdown({ breakdown, category: s.category }).rows;
    expect(rows.find((r) => r.id === 'coffee')!.drillId).toBe('coffee');
    expect(rows.find((r) => r.id === 'food__direct')!.drillId).toBe('food');
    expect(rows.find((r) => r.id === UNCATEGORIZED_KEY)!.drillId).toBe(UNCATEGORIZED_KEY);
    // the parent row itself is not a drill target (it expands)
    expect(rows.find((r) => r.id === 'food')!.hasChildren).toBe(true);
  });
});
