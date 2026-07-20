// WHIT-308 — categoryTransactions GAPS (adversarial): edges the implementer's
// categoryTransactions.logic.test.ts leaves open.
//   [A-G1] a runtime-stray status (outside pending|posted) is LISTED but adds 0 to the total
//   [A-G2] a refund that drives BOTH buckets net-negative → non-null, total 0 (NOT the null empty state)
//   [A-G3] an id with a slash / '__' is matched by exact equality (no id string-parsing)
import { describe, it, expect } from '@jest/globals';
import { categoryTransactions } from '../context';
import { makeState, cat, txn } from './factory';
import type { Transaction } from '../context';

const cats = [cat({ id: 'coffee', name: 'Cafes & Coffee', bucket: 'Lifestyle' })];
const OPEN = { start: '2026-01-01', end: '2026-12-31' };

describe('categoryTransactions — adversarial gaps', () => {
  // [A-G1] The total loop is `if posted … else if pending …` — a stray status contributes to
  // neither bucket. It still passes the category filter, so it's LISTED (count) but not TOTALLED.
  // Fail-on-revert: turning the `else if (t.status === 'pending')` into a bare `else` would fold
  // the stray into pending and break the total.
  it('lists a stray-status transaction but does not add it to the total', () => {
    const s = makeState({
      categories: cats,
      transactions: [
        txn({ transaction_id: 'p1', category: 'coffee', amount: -10, status: 'posted', date: '2026-06-10' }),
        txn({ transaction_id: 's1', category: 'coffee', amount: -99, status: 'removed' as unknown as Transaction['status'], date: '2026-06-11' }),
      ],
    });
    const detail = categoryTransactions(s, 'coffee', OPEN)!;
    expect(detail.count).toBe(2);     // the stray row is still shown
    expect(detail.total).toBe(10);    // …but only the posted spend counts
    expect(detail.pending).toBe(0);
  });

  // [A-G2] A refund larger than spend in BOTH buckets clamps each to 0 → total 0. Because rows
  // still match, the result is NON-NULL (a $0 card over a real list), not the null empty state.
  // Fail-on-revert: a `if (total === 0) return null` shortcut, or dropping the per-bucket clamp,
  // both break this.
  it('returns a non-null $0 detail (not the empty state) when refunds net both buckets negative', () => {
    const s = makeState({
      categories: cats,
      transactions: [
        txn({ transaction_id: 'sp', category: 'coffee', amount: -10, status: 'posted', date: '2026-06-10' }),
        txn({ transaction_id: 'rf', category: 'coffee', amount: 25, status: 'posted', date: '2026-06-11' }),  // big refund
        txn({ transaction_id: 'qp', category: 'coffee', amount: -5, status: 'pending', date: '2026-06-12' }),
        txn({ transaction_id: 'qr', category: 'coffee', amount: 20, status: 'pending', date: '2026-06-13' }), // pending reversal
      ],
    });
    const detail = categoryTransactions(s, 'coffee', OPEN);
    expect(detail).not.toBeNull();
    expect(detail!.count).toBe(4);
    expect(detail!.posted).toBe(0);
    expect(detail!.pending).toBe(0);
    expect(detail!.total).toBe(0);
  });

  // [A-G3] drillId is matched by exact `t.category === drillId` — no splitting on '/' or '__'.
  // An id carrying those characters (a route round-trips it via encodeURIComponent) still filters
  // cleanly. Guards the design note that the drill does NO id string-parsing.
  it('matches an id containing a slash / "__" by exact equality', () => {
    const weird = 'food/sub__direct';
    const s = makeState({
      categories: [cat({ id: weird, name: 'Weird', bucket: 'Living' })],
      transactions: [
        txn({ transaction_id: 'w1', category: weird, amount: -7, status: 'posted', date: '2026-06-10' }),
        txn({ transaction_id: 'food', category: 'food', amount: -7, status: 'posted', date: '2026-06-10' }),
      ],
    });
    const detail = categoryTransactions(s, weird, OPEN)!;
    expect(detail.count).toBe(1);
    expect(detail.groups.flatMap((g) => g.items.map((t) => t.transaction_id))).toEqual(['w1']);
  });
});
