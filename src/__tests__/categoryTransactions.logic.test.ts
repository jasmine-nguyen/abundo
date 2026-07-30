// WHIT-308/WHIT-342: categoryTransactions — the transactions behind an Insights spend row.
// The rows now arrive already scoped server-side to the drill (one category, or the
// uncategorized bucket) over the selected cycle, so categoryTransactions just groups + totals
// them (no client-side window/category filtering — that moved to the server, tested in pytest).
// Pure over { transactions, category }, so it runs headlessly via makeState.
import { describe, it, expect } from '@jest/globals';
import { categoryTransactions, categoryBreakdown, UNCATEGORIZED_KEY } from '../context';
import { makeState, cat, txn, spend, withRollup } from './factory';

const cats = [
  cat({ id: 'coffee', name: 'Cafes & Coffee', bucket: 'Lifestyle' }),
  cat({ id: 'groceries', name: 'Groceries', bucket: 'Living' }),
];

describe('categoryTransactions', () => {
  it('groups a named category’s server rows and totals the spend', () => {
    const s = makeState({
      categories: cats,
      transactions: [
        txn({ transaction_id: 'c1', category: 'coffee', amount: -20, status: 'posted', date: '2026-06-10' }),
        txn({ transaction_id: 'c2', category: 'coffee', amount: -5, status: 'pending', date: '2026-06-11' }),
      ],
    });
    const detail = categoryTransactions(s, 'coffee')!;
    expect(detail.name).toBe('Cafes & Coffee');
    expect(detail.count).toBe(2);
    expect(detail.total).toBe(25);
    expect(detail.pending).toBe(5);
    expect(detail.posted).toBe(20);
    expect(detail.groups.flatMap((g) => g.items.map((t) => t.transaction_id)).sort()).toEqual(['c1', 'c2']);
  });

  // FAIL-ON-REVERT: posted and pending clamp INDEPENDENTLY (mirroring shared/spend.py _summarise),
  // not as one aggregate. A refund that drives the posted bucket net-negative clamps that bucket
  // to 0 without eating into pending.
  it('clamps posted and pending buckets separately, not the aggregate', () => {
    const s = makeState({
      categories: cats,
      transactions: [
        txn({ transaction_id: 'p1', category: 'coffee', amount: -10, status: 'posted', date: '2026-06-10' }),
        txn({ transaction_id: 'r1', category: 'coffee', amount: 15, status: 'posted', date: '2026-06-11' }), // refund
        txn({ transaction_id: 'q1', category: 'coffee', amount: -25, status: 'pending', date: '2026-06-12' }),
      ],
    });
    const detail = categoryTransactions(s, 'coffee')!;
    // posted = max(0, 10 - 15) = 0; pending = 25 → total 25. An aggregate clamp would give 20.
    expect(detail.posted).toBe(0);
    expect(detail.pending).toBe(25);
    expect(detail.total).toBe(25);
  });

  it('lists every named-category row (refunds + budget-excluded) but only counts contributors in the total', () => {
    const s = makeState({
      categories: cats,
      transactions: [
        txn({ transaction_id: 'c1', category: 'coffee', amount: -20, status: 'posted', date: '2026-06-10' }),
        txn({ transaction_id: 'x1', category: 'coffee', amount: -12, status: 'posted', date: '2026-06-11', budget_excluded: true }),
      ],
    });
    const detail = categoryTransactions(s, 'coffee')!;
    expect(detail.count).toBe(2);       // the excluded row is still LISTED (like accountDetail)
    expect(detail.total).toBe(20);      // ...but it doesn't add to the total
  });

  it('names the Uncategorized bucket and totals its (already contributing-only) server rows', () => {
    const s = makeState({
      categories: cats,
      transactions: [
        txn({ transaction_id: 'u1', category: null, amount: -30, status: 'posted', date: '2026-06-10' }),
        txn({ transaction_id: 'u2', category: 'RAW_ENUM', amount: -8, status: 'pending', date: '2026-06-11' }),
      ],
    });
    const detail = categoryTransactions(s, UNCATEGORIZED_KEY)!;
    expect(detail.name).toBe('Uncategorized');
    expect(detail.groups.flatMap((g) => g.items.map((t) => t.transaction_id)).sort()).toEqual(['u1', 'u2']);
    expect(detail.total).toBe(38); // 30 posted + 8 pending
  });

  it('returns null when the server returns no rows (empty cycle or stale deep-link)', () => {
    const s = makeState({ categories: cats, transactions: [] });
    expect(categoryTransactions(s, 'coffee')).toBeNull();
    expect(categoryTransactions(s, UNCATEGORIZED_KEY)).toBeNull();
  });

  // The card's acceptance test: the drilled total equals the categoryBreakdown row it came from —
  // for a leaf, a "Directly in X" (parent) row, and Uncategorized — GIVEN the rows the server
  // returns for that drill (exact category id, or the uncategorized bucket).
  it('reconciles the drilled total with the categoryBreakdown row', () => {
    const treeCats = [
      cat({ id: 'food', name: 'Food', bucket: 'Living' }),
      cat({ id: 'coffee', name: 'Coffee', bucket: 'Living', parent: 'food' }),
    ];
    const breakdown = withRollup(
      {
        food: spend({ posted: 30, pending: 0 }),
        coffee: spend({ posted: 20, pending: 5 }),
        [UNCATEGORIZED_KEY]: spend({ posted: 14, pending: 0 }),
      },
      { nodes: { food: { posted: 50, pending: 5 } } },  // direct 30 + coffee 25
    );
    // The rows the server returns per drill: exact category id, or the uncategorized bucket.
    const serverRows: Record<string, ReturnType<typeof txn>[]> = {
      food: [txn({ transaction_id: 'f1', category: 'food', amount: -30, status: 'posted', date: '2026-06-10' })],
      coffee: [
        txn({ transaction_id: 'c1', category: 'coffee', amount: -20, status: 'posted', date: '2026-06-11' }),
        txn({ transaction_id: 'c2', category: 'coffee', amount: -5, status: 'pending', date: '2026-06-12' }),
      ],
      [UNCATEGORIZED_KEY]: [txn({ transaction_id: 'u1', category: null, amount: -14, status: 'posted', date: '2026-06-10' })],
    };
    const base = makeState({ categories: treeCats, breakdown });
    const { rows } = categoryBreakdown({ breakdown, category: base.category });

    for (const row of rows) {
      if (row.hasChildren) continue; // parent rows expand, not drill
      const s = makeState({ categories: treeCats, transactions: serverRows[row.drillId] });
      const detail = categoryTransactions(s, row.drillId);
      expect(detail).not.toBeNull();
      expect(detail!.total).toBe(row.spent);
    }
    // and specifically the "Directly in Food" row drills into the parent id, matching its own spend
    const direct = rows.find((r) => r.id === 'food__direct')!;
    expect(direct.drillId).toBe('food');
    const foodState = makeState({ categories: treeCats, transactions: serverRows['food'] });
    expect(categoryTransactions(foodState, direct.drillId)!.total).toBe(30);
  });
});

describe('categoryBreakdown drillId', () => {
  it('sets drillId to the row’s own id for a leaf and Uncategorized, and to the parent for a "Directly in X" row', () => {
    const treeCats = [
      cat({ id: 'food', name: 'Food', bucket: 'Living' }),
      cat({ id: 'coffee', name: 'Coffee', bucket: 'Living', parent: 'food' }),
    ];
    const breakdown = withRollup(
      {
        food: spend({ posted: 30, pending: 0 }),   // direct-in-parent → forces a __direct row
        coffee: spend({ posted: 20, pending: 0 }),
        [UNCATEGORIZED_KEY]: spend({ posted: 14, pending: 0 }),
      },
      { nodes: { food: { posted: 50, pending: 0 } } },  // direct 30 + coffee 20
    );
    const s = makeState({ categories: treeCats, breakdown });
    const rows = categoryBreakdown({ breakdown, category: s.category }).rows;
    expect(rows.find((r) => r.id === 'coffee')!.drillId).toBe('coffee');
    expect(rows.find((r) => r.id === 'food__direct')!.drillId).toBe('food');
    expect(rows.find((r) => r.id === UNCATEGORIZED_KEY)!.drillId).toBe(UNCATEGORIZED_KEY);
    // the parent row itself is not a drill target (it expands)
    expect(rows.find((r) => r.id === 'food')!.hasChildren).toBe(true);
  });

  // WHIT-366: income is stored POSITIVE (server sign=+1), spend is negated. An Income-bucket
  // drill must sum +amount so it totals to its earnings — not clamp to $0 like a spend drill would.
  // FAIL-ON-REVERT: drop the isIncome sign flip and this income total collapses to 0.
  it('totals an Income-bucket category to its POSITIVE earnings (not clamped to $0)', () => {
    const s = makeState({
      categories: [cat({ id: 'salary', name: 'Salary', bucket: 'Income' })],
      transactions: [
        txn({ transaction_id: 's1', category: 'salary', amount: 4000, status: 'posted', date: '2026-06-10' }),
        txn({ transaction_id: 's2', category: 'salary', amount: 500, status: 'pending', date: '2026-06-24' }),
      ],
    });
    const detail = categoryTransactions(s, 'salary')!;
    expect(detail.name).toBe('Salary');
    expect(detail.posted).toBe(4000);
    expect(detail.pending).toBe(500);
    expect(detail.total).toBe(4500);
  });

  // REGRESSION: the sign flip is income-ONLY. A spend drill still negates (a positive amount is a
  // refund and clamps its bucket to 0), so the sign flip can't silently invert spend totals.
  it('leaves a spend-bucket drill on the spend sign (a positive amount is a refund, clamps to 0)', () => {
    const s = makeState({
      categories: [cat({ id: 'coffee', name: 'Coffee', bucket: 'Lifestyle' })],
      transactions: [
        txn({ transaction_id: 'c1', category: 'coffee', amount: -20, status: 'posted', date: '2026-06-10' }),
        txn({ transaction_id: 'r1', category: 'coffee', amount: 50, status: 'posted', date: '2026-06-11' }), // refund > spend
      ],
    });
    const detail = categoryTransactions(s, 'coffee')!;
    expect(detail.posted).toBe(0);   // max(0, 20 - 50) = 0 — NOT a positive 30 an income sign would give
    expect(detail.total).toBe(0);
  });
});
