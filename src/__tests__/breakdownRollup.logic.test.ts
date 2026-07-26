// WHIT-349 slice 3+4: categoryBreakdown reads the server's __rollup__ (netted parent totals +
// refund detail) instead of tallying floored leaves on-device. When __rollup__ is ABSENT the
// selector falls back to the on-device tally — covered by breakdown.logic.test.ts (no rollup),
// which must stay byte-identical. This file covers the rollup-present path.
import { describe, it, expect } from '@jest/globals';
import { categoryBreakdown } from '../context';
import type { BreakdownRollup, CategorySpend } from '../api';
import { makeState, cat, spend } from './factory';

// Attach the runtime __rollup__ sentinel to a breakdown map (it rides in the same object the
// server returns; the factory types `breakdown` as Record<string, CategorySpend>, so cast).
function withRollup(bd: Record<string, CategorySpend>, rollup: BreakdownRollup): Record<string, CategorySpend> {
  (bd as Record<string, unknown>).__rollup__ = rollup;
  return bd;
}

const CAR_TREE = [
  cat({ id: 'car', name: 'Car', bucket: 'Living', parent: null }),
  cat({ id: 'petrol', name: 'Petrol', bucket: 'Living', parent: 'car' }),
  cat({ id: 'tolls', name: 'Tolls', bucket: 'Living', parent: 'car' }),
];

describe('categoryBreakdown — server __rollup__ (WHIT-349)', () => {
  it('reads a parent total from the netted server node (== its Budgets bar), not floored leaves', () => {
    // petrol 60, tolls net -30 (floored to 0, dropped from the flat rows). Server node = 30.
    // Fail-on-revert: computeCombined over floored leaves gives 60.
    const s = makeState({
      categories: CAR_TREE,
      breakdown: withRollup(
        { petrol: spend({ posted: 60, pending: 0 }), tolls: spend({ posted: 0, pending: 0 }) },
        { nodes: { car: { posted: 30, pending: 0 } }, refunds: { car: [{ id: 'tolls', amount: -30 }] } },
      ),
    });
    const byId = Object.fromEntries(categoryBreakdown(s).rows.map((r) => [r.id, r]));
    expect(byId['car']).toMatchObject({ spent: 30, depth: 0, hasChildren: true });
    expect(byId['petrol']).toMatchObject({ spent: 60, depth: 1, parentId: 'car' });  // floored leaf, unchanged
  });

  it('emits a refund line so an expanded parent still reconciles to its netted node', () => {
    const s = makeState({
      categories: CAR_TREE,
      breakdown: withRollup(
        { petrol: spend({ posted: 60, pending: 0 }), tolls: spend({ posted: 0, pending: 0 }) },
        { nodes: { car: { posted: 30, pending: 0 } }, refunds: { car: [{ id: 'tolls', amount: -30 }] } },
      ),
    });
    const byId = Object.fromEntries(categoryBreakdown(s).rows.map((r) => [r.id, r]));
    const refund = byId['tolls__refund'];
    expect(refund).toMatchObject({ isRefund: true, spent: -30, parentId: 'car', depth: 1, drillId: 'tolls', hasChildren: false });
    expect(refund.name).toBe('Tolls');
    expect(refund.spentLabel).toContain('refund');
    // Visible children (petrol 60) + refund line (-30) == the netted parent node (30).
    expect(byId['petrol'].spent + refund.spent).toBe(byId['car'].spent);
  });

  it('hero total sums depth-0 netted rows only (no grandchild double-count)', () => {
    // 3-level: car (own 5) > travel (own 5) > petrol 60; a separate top-level coffee 20 (leaf).
    // car node = 70, travel node = 65. Total must be 70 + 20 = 90 (top-level only), NOT the sum
    // of every node. Fail-on-revert: summing every node (70+65) or node+leaves double-counts.
    const s = makeState({
      categories: [
        cat({ id: 'car', name: 'Car', bucket: 'Living', parent: null }),
        cat({ id: 'travel', name: 'Travel', bucket: 'Living', parent: 'car' }),
        cat({ id: 'petrol', name: 'Petrol', bucket: 'Living', parent: 'travel' }),
        cat({ id: 'coffee', name: 'Coffee', bucket: 'Lifestyle', parent: null }),
      ],
      breakdown: withRollup(
        {
          car: spend({ posted: 5, pending: 0 }), travel: spend({ posted: 5, pending: 0 }),
          petrol: spend({ posted: 60, pending: 0 }), coffee: spend({ posted: 20, pending: 0 }),
        },
        { nodes: { car: { posted: 70, pending: 0 }, travel: { posted: 65, pending: 0 } } },
      ),
    });
    const { rows, total } = categoryBreakdown(s);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId['car'].spent).toBe(70);
    expect(byId['travel'].spent).toBe(65);   // its own node, nested
    expect(byId['coffee'].spent).toBe(20);   // top-level leaf, floored
    expect(total).toBe(90);                  // 70 (car) + 20 (coffee); NOT 70+65+...
  });

  it('a fully-refunded parent (no node) shows 0 and drops — never the floored leaf sum', () => {
    // shoes +100, clothes net -150 -> shopping subtree nets -50 -> server emits NO node for it.
    // A positive floored leaf (shoes) still pulls shopping into the tree. It must read 0 and drop
    // (matches Budgets), not computeCombined's floored 100. Fail-on-revert: without the parent-vs-
    // leaf branch, shopping renders as 100.
    const s = makeState({
      categories: [
        cat({ id: 'shopping', name: 'Shopping', bucket: 'Living', parent: null }),
        cat({ id: 'shoes', name: 'Shoes', bucket: 'Living', parent: 'shopping' }),
        cat({ id: 'clothes', name: 'Clothes', bucket: 'Living', parent: 'shopping' }),
      ],
      breakdown: withRollup(
        { shoes: spend({ posted: 100, pending: 0 }), clothes: spend({ posted: 0, pending: 0 }) },
        { nodes: {} },   // shopping omitted: its subtree netted <= 0
      ),
    });
    const { rows, total } = categoryBreakdown(s);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId['shopping']).toBeUndefined();   // dropped, not a phantom $100
    expect(total).toBe(0);                       // the net-zero subtree contributes nothing
  });

  it('the refund line is excluded from the hero total and never a top-level row', () => {
    const s = makeState({
      categories: CAR_TREE,
      breakdown: withRollup(
        { petrol: spend({ posted: 60, pending: 0 }), tolls: spend({ posted: 0, pending: 0 }) },
        { nodes: { car: { posted: 30, pending: 0 } }, refunds: { car: [{ id: 'tolls', amount: -30 }] } },
      ),
    });
    const { rows, total } = categoryBreakdown(s);
    expect(total).toBe(30);   // the -30 refund line is NOT subtracted again from the netted total
    expect(rows.filter((r) => r.depth === 0 && r.isRefund)).toEqual([]);   // never top-level
    expect(rows.find((r) => r.isRefund)!.pct).toBe(0);   // no bar share
  });

  it('a flat taxonomy under an empty __rollup__ renders every leaf via the server path (WHIT-358)', () => {
    // Slice 5a: a new server ALWAYS emits __rollup__, so a flat setup (no parents) arrives as
    // {nodes: {}} — not an absent key. The selector takes the rollup path (structureSeed = the
    // present ids), and each flat leaf reads its own floored value. Result must match what the
    // fallback produced for the same data: every leaf a depth-0 row, total = their floored sum.
    const s = makeState({
      categories: [
        cat({ id: 'coffee', name: 'Coffee', bucket: 'Lifestyle', parent: null }),
        cat({ id: 'groceries', name: 'Groceries', bucket: 'Living', parent: null }),
      ],
      breakdown: withRollup(
        { coffee: spend({ posted: 50, pending: 0 }), groceries: spend({ posted: 30, pending: 0 }) },
        { nodes: {} },
      ),
    });
    const { rows, total } = categoryBreakdown(s);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId['coffee']).toMatchObject({ spent: 50, depth: 0, hasChildren: false });
    expect(byId['groceries']).toMatchObject({ spent: 30, depth: 0, hasChildren: false });
    expect(total).toBe(80);
  });

  it('does not turn the __rollup__ sentinel into a phantom spend row', () => {
    const s = makeState({
      categories: CAR_TREE,
      breakdown: withRollup(
        { petrol: spend({ posted: 60, pending: 0 }) },
        { nodes: {} },
      ),
    });
    const rows = categoryBreakdown(s).rows;
    expect(rows.find((r) => r.id === '__rollup__')).toBeUndefined();
  });
});
