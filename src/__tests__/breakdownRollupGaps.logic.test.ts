// WHIT-349 slice 3+4 — QA GAP tests for categoryBreakdown's server __rollup__ path.
// The implementer's breakdownRollup.logic.test.ts locks: netted parent == node, single-level
// refund reconciliation, hero depth-0 no-double-count, fully-refunded parent -> 0/dropped,
// refund excluded from total, sentinel not a row. These add the ADVERSARIAL edges:
//   [G1] WHIT-357: the independent posted/pending clamp gap, now PLUGGED so the list reconciles,
//   [G8] WHIT-357: a dropped net-negative mid-parent, plugged at its grandparent,
//   [G9] WHIT-357: a subtree that already sums gets no plug (the fix is inert on the happy path),
//   [G2] refunds keyed under a parent that never rendered -> the `!rowById.has(parent)` guard,
//   [G3] a fully-refunded parent's positive floored leaf -> orphan, kept out of the hero,
//   [G4] multi-level: a positive mid-parent with its OWN refund line + a shown sibling,
//   [G5] uncategorized coexisting with a refund; earned never a row; totals correct,
//   [G6] fallback (no __rollup__) is byte-identical to the pre-WHIT-349 on-device tally.
import { describe, it, expect } from '@jest/globals';
import { categoryBreakdown } from '../context';
import type { BreakdownRollup, CategorySpend } from '../api';
import { makeState, cat, spend } from './factory';

function withRollup(bd: Record<string, CategorySpend>, rollup: BreakdownRollup): Record<string, CategorySpend> {
  (bd as Record<string, unknown>).__rollup__ = rollup;
  return bd;
}

const CAR_TREE = [
  cat({ id: 'car', name: 'Car', bucket: 'Living', parent: null }),
  cat({ id: 'petrol', name: 'Petrol', bucket: 'Living', parent: 'car' }),
  cat({ id: 'tolls', name: 'Tolls', bucket: 'Living', parent: 'car' }),
];

describe('categoryBreakdown — WHIT-349 refund GAPs', () => {
  it('[G1] WHIT-357: posted surplus + pending refund is plugged so the expanded list sums to the node', () => {
    // The server node folds posted/pending independently (petrol +100 posted, tolls -30 pending
    // -> node = {100, 0} = 100) but the refund line reports tolls' COMBINED net (-30). Left alone,
    // the visible rows (petrol 100 + refund -30 = 70) under-sum the parent (100). WHIT-357 plugs
    // the +30 clamped remainder with a synthetic "Other" line so the expanded list reconciles.
    // Fail-on-revert: drop the remainder loop and there is no car__remainder -> this test errors.
    const s = makeState({
      categories: CAR_TREE,
      breakdown: withRollup(
        { petrol: spend({ posted: 100, pending: 0 }), tolls: spend({ posted: 0, pending: 0 }) },
        { nodes: { car: { posted: 100, pending: 0 } }, refunds: { car: [{ id: 'tolls', amount: -30 }] } },
      ),
    });
    const { rows, total } = categoryBreakdown(s);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId['car'].spent).toBe(100);                 // netted parent == its Budgets bar
    expect(byId['petrol'].spent).toBe(100);              // shown child
    expect(byId['tolls__refund'].spent).toBe(-30);       // refund line (combined net)
    // The plug: a positive "Other" line closing the clamped-pending gap, muted (pct 0), under car.
    expect(byId['car__remainder']).toMatchObject({
      spent: 30, isRemainder: true, parentId: 'car', depth: 1, pct: 0, name: 'Pending/refund adjustment',
    });
    // Full reconciliation: petrol (100) + refund (-30) + Other (+30) == car node (100).
    expect(byId['petrol'].spent + byId['tolls__refund'].spent + byId['car__remainder'].spent).toBe(100);
    expect(total).toBe(100);                             // remainder is depth 1 -> never in the hero
  });

  it('[G8] WHIT-357: a dropped net-negative mid-parent is plugged so its grandparent still sums', () => {
    // car own +100 -> travel own +20 -> flights -60. Node car folds to 60 ({posted 100+20-60}).
    // Node travel folds to -40 -> floored -> absent -> travel (a parent reading an absent node) is
    // dropped, taking its own +20 with it; flights drops too. No refund line is emitted (travel is
    // not "hidden": it has its own +20). Left alone, the only visible child "Directly in Car" (100)
    // over-sums the node (60). WHIT-357 plugs the -40 so the expanded list reconciles.
    // Fail-on-revert: without the remainder loop car__direct (100) alone != car node (60).
    const s = makeState({
      categories: [
        cat({ id: 'car', name: 'Car', bucket: 'Living', parent: null }),
        cat({ id: 'travel', name: 'Travel', bucket: 'Living', parent: 'car' }),
        cat({ id: 'flights', name: 'Flights', bucket: 'Living', parent: 'travel' }),
      ],
      breakdown: withRollup(
        {
          car: spend({ posted: 100, pending: 0 }),
          travel: spend({ posted: 20, pending: 0 }),
          flights: spend({ posted: 0, pending: 0 }),   // -60 signed, floored to {0,0} in the flat summary
        },
        { nodes: { car: { posted: 60, pending: 0 } } },   // travel node folds to <=0 -> omitted
      ),
    });
    const { rows, total } = categoryBreakdown(s);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId['car'].spent).toBe(60);                  // the netted node (== Budgets bar)
    expect(byId['car__direct'].spent).toBe(100);         // car's own directly-tagged spend
    expect(byId['travel']).toBeUndefined();              // net-negative mid-parent dropped
    expect(byId['flights']).toBeUndefined();
    // The plug: a NEGATIVE "Other" line for the dropped subtree, muted, under car.
    expect(byId['car__remainder']).toMatchObject({
      spent: -40, isRemainder: true, parentId: 'car', depth: 1, pct: 0, name: 'Pending/refund adjustment',
    });
    // Full reconciliation: "Directly in Car" (100) + Other (-40) == car node (60).
    expect(byId['car__direct'].spent + byId['car__remainder'].spent).toBe(60);
    expect(total).toBe(60);
  });

  it('[G9] WHIT-357: a subtree that already reconciles gets NO "Other" line (the plug is inert)', () => {
    // The [G4]-shaped tree already sums at every level (taxi 40 + refund -30 == travel 10; petrol
    // 60 + travel 10 == car 70), so abs(remainder) < epsilon everywhere and no synthetic row is
    // emitted. Proves the fix is inert on the happy path — it only fires on a real gap.
    const s = makeState({
      categories: [
        cat({ id: 'car', name: 'Car', bucket: 'Living', parent: null }),
        cat({ id: 'petrol', name: 'Petrol', bucket: 'Living', parent: 'car' }),
        cat({ id: 'travel', name: 'Travel', bucket: 'Living', parent: 'car' }),
        cat({ id: 'taxi', name: 'Taxi', bucket: 'Living', parent: 'travel' }),
        cat({ id: 'tolls', name: 'Tolls', bucket: 'Living', parent: 'travel' }),
      ],
      breakdown: withRollup(
        {
          petrol: spend({ posted: 60, pending: 0 }),
          taxi: spend({ posted: 40, pending: 0 }),
          tolls: spend({ posted: 0, pending: 0 }),
        },
        {
          nodes: { car: { posted: 70, pending: 0 }, travel: { posted: 10, pending: 0 } },
          refunds: { travel: [{ id: 'tolls', amount: -30 }] },
        },
      ),
    });
    const { rows, total } = categoryBreakdown(s);
    expect(rows.some((r) => r.isRemainder)).toBe(false);   // no plug anywhere
    expect(total).toBe(70);                                // hero unchanged by the (absent) plug
  });

  it('[G2] a refund keyed under a parent that never rendered is skipped, not crashed', () => {
    // rollup.refunds names `ghost` (no node, no flat spend -> no row). The `!rowById.has(parent)`
    // guard must skip it: no ghost__refund row, no throw. Fail-on-revert: drop the guard and
    // rowById.get(parentId)!.depth throws on undefined -> this test errors.
    const s = makeState({
      categories: [...CAR_TREE, cat({ id: 'ghost', name: 'Ghost', bucket: 'Living', parent: null })],
      breakdown: withRollup(
        { petrol: spend({ posted: 60, pending: 0 }) },
        {
          nodes: { car: { posted: 60, pending: 0 } },
          refunds: { ghost: [{ id: 'tolls', amount: -30 }], car: [] },
        },
      ),
    });
    const { rows } = categoryBreakdown(s);
    expect(rows.find((r) => r.id === 'tolls__refund')).toBeUndefined();   // not attached anywhere
    expect(rows.find((r) => r.parentId === 'ghost')).toBeUndefined();
    expect(rows.find((r) => r.id === 'car')).toMatchObject({ spent: 60 });   // real rows survive
  });

  it('[G3] a fully-refunded parent keeps its positive floored leaf OUT of the hero', () => {
    // shopping subtree nets <= 0 -> no node -> shopping dropped. shoes (+100 floored) still
    // pulls shopping into the tree, so shoes renders as a depth-1 orphan under the dropped
    // parent (screen-hidden: its parent is never shown/expanded). It must NOT be a depth-0
    // row and must NOT leak into the hero total. Fail-on-revert: without the parent-vs-leaf
    // branch, shopping reads the floored 100 and both it and the leaf hit the hero.
    const s = makeState({
      categories: [
        cat({ id: 'shopping', name: 'Shopping', bucket: 'Living', parent: null }),
        cat({ id: 'shoes', name: 'Shoes', bucket: 'Living', parent: 'shopping' }),
        cat({ id: 'clothes', name: 'Clothes', bucket: 'Living', parent: 'shopping' }),
      ],
      breakdown: withRollup(
        { shoes: spend({ posted: 100, pending: 0 }), clothes: spend({ posted: 0, pending: 0 }) },
        { nodes: {} },
      ),
    });
    const { rows, total } = categoryBreakdown(s);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId['shopping']).toBeUndefined();
    expect(total).toBe(0);                                        // net-zero subtree -> no hero $
    expect(rows.filter((r) => r.depth === 0)).toEqual([]);       // no top-level row at all
    // The orphan leaf is still IN the rows array (a known quirk) but at depth 1 under the
    // dropped parent, so the screen's shown-filter hides it and the hero ignores it.
    expect(byId['shoes']).toMatchObject({ depth: 1, parentId: 'shopping' });
  });

  it('[G4] multi-level: a mid-parent with a SURVIVING child carries its own refund line', () => {
    // car > {petrol +60, travel}; travel > {taxi +40, tolls -30}. travel has a surviving flat
    // child (taxi) so the client sees it as a parent and reads its node (10). The refund
    // attaches to travel: taxi 40 + refund -30 == travel node 10; petrol 60 + travel 10 == car
    // node 70. Reconciles at BOTH levels. (The mid-parent WITHOUT a surviving child is a real
    // bug — see [G7].)
    const s = makeState({
      categories: [
        cat({ id: 'car', name: 'Car', bucket: 'Living', parent: null }),
        cat({ id: 'petrol', name: 'Petrol', bucket: 'Living', parent: 'car' }),
        cat({ id: 'travel', name: 'Travel', bucket: 'Living', parent: 'car' }),
        cat({ id: 'taxi', name: 'Taxi', bucket: 'Living', parent: 'travel' }),
        cat({ id: 'tolls', name: 'Tolls', bucket: 'Living', parent: 'travel' }),
      ],
      breakdown: withRollup(
        {
          petrol: spend({ posted: 60, pending: 0 }),
          taxi: spend({ posted: 40, pending: 0 }),     // surviving flat child -> travel reads as a parent
          tolls: spend({ posted: 0, pending: 0 }),
        },
        {
          nodes: { car: { posted: 70, pending: 0 }, travel: { posted: 10, pending: 0 } },
          refunds: { travel: [{ id: 'tolls', amount: -30 }] },
        },
      ),
    });
    const { rows, total } = categoryBreakdown(s);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    const refund = byId['tolls__refund'];
    expect(byId['car']).toMatchObject({ spent: 70, depth: 0 });
    expect(byId['travel']).toMatchObject({ spent: 10, depth: 1, parentId: 'car' });
    expect(refund).toMatchObject({ isRefund: true, spent: -30, depth: 2, parentId: 'travel' });
    // travel reconciles: taxi (40) + refund (-30) == travel node (10).
    expect(byId['taxi'].spent + refund.spent).toBe(byId['travel'].spent);
    // car reconciles: petrol (60) + travel node (10) == car node (70).
    expect(byId['petrol'].spent + byId['travel'].spent).toBe(byId['car'].spent);
    expect(total).toBe(70);   // only car is depth-0
  });

  it('[G7] a parent with own spend + an only-refunded child reads its NODE, not its direct spend', () => {
    // car own +50 direct spend, tolls (only child) net -30 -> floored to {0,0}. The server node
    // car = 20 (== its Budgets bar). Under the roll-up the tree shape is seeded from `present`
    // (which includes the {0,0} tolls), so car is recognised as a parent and reads nodes['car']
    // (20), NOT its own direct 50 -> donut/hero == Budgets. The expanded view reconciles:
    // "Directly in Car" (50) + Tolls refund (-30) = 20. Fail-on-revert: keying `isParent` on
    // flat-surviving children (the old bug) makes car read 50 and inflates the hero.
    const s = makeState({
      categories: [
        cat({ id: 'car', name: 'Car', bucket: 'Living', parent: null }),
        cat({ id: 'tolls', name: 'Tolls', bucket: 'Living', parent: 'car' }),
      ],
      breakdown: withRollup(
        { car: spend({ posted: 50, pending: 0 }), tolls: spend({ posted: 0, pending: 0 }) },
        { nodes: { car: { posted: 20, pending: 0 } }, refunds: { car: [{ id: 'tolls', amount: -30 }] } },
      ),
    });
    const { rows, total } = categoryBreakdown(s);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId['car'].spent).toBe(20);              // the netted node (== Budgets), not the direct 50
    expect(byId['car'].hasChildren).toBe(true);      // expandable (so the refund line is reachable)
    expect(total).toBe(20);                          // hero == Budgets, not inflated by the refund
    // Expanded reconciliation: "Directly in Car" (own 50) + Tolls refund (-30) == the node (20).
    expect(byId['car__direct']).toMatchObject({ spent: 50, parentId: 'car' });
    expect(byId['tolls__refund']).toMatchObject({ isRefund: true, spent: -30, parentId: 'car' });
    expect(byId['car__direct'].spent + byId['tolls__refund'].spent).toBe(byId['car'].spent);
  });

  it('[G5] uncategorized coexists with a refund; earned is not a row; totals are correct', () => {
    // A refunded car parent + an Uncategorized bucket + an __earned__ bucket. Uncategorized is a
    // depth-0 row and counts to the hero; __earned__ is skipped (not spend); the refund never
    // hits the hero. total = car node (30) + uncategorized (25).
    const s = makeState({
      categories: CAR_TREE,
      breakdown: withRollup(
        {
          petrol: spend({ posted: 60, pending: 0 }), tolls: spend({ posted: 0, pending: 0 }),
          __uncategorized__: spend({ posted: 25, pending: 0 }),
          __earned__: spend({ posted: 2000, pending: 0 }),
        },
        { nodes: { car: { posted: 30, pending: 0 } }, refunds: { car: [{ id: 'tolls', amount: -30 }] } },
      ),
    });
    const { rows, total } = categoryBreakdown(s);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId['__uncategorized__']).toMatchObject({ spent: 25, depth: 0 });
    expect(byId['__earned__']).toBeUndefined();       // income total is never a spend row
    expect(byId['tolls__refund']).toMatchObject({ isRefund: true, spent: -30 });
    expect(total).toBe(55);                            // 30 (car node) + 25 (uncat); refund excluded
  });
});
