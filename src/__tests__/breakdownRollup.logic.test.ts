// WHIT-349 slice 3+4: categoryBreakdown reads the server's __rollup__ (netted parent totals +
// refund detail) to size each parent, rather than tallying floored leaves on-device. Since the
// server always emits __rollup__ (WHIT-358), this is the only path; this file covers it.
import { describe, it, expect } from '@jest/globals';
import { categoryBreakdown, readRollup } from '../context';
import { C } from '../theme';
import { makeState, cat, spend, withRollup } from './factory';

const CAR_TREE = [
  cat({ id: 'car', name: 'Car', bucket: 'Living', parent: null }),
  cat({ id: 'petrol', name: 'Petrol', bucket: 'Living', parent: 'car' }),
  cat({ id: 'tolls', name: 'Tolls', bucket: 'Living', parent: 'car' }),
];

describe('categoryBreakdown — server __rollup__ (WHIT-349)', () => {
  it('reads a parent total from the netted server node (== its Budgets bar), not floored leaves', () => {
    // petrol 60, tolls net -30 (floored to 0, dropped from the flat rows). Server node = 30.
    // Fail-on-revert: reading the floored leaf sum instead of the node gives 60.
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
    // (matches Budgets), not the floored leaf sum of 100. Fail-on-revert: without the parent-vs-
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
    // {nodes: {}} — not an absent key. Each flat leaf reads its own floored value: every leaf a
    // depth-0 row, total = their floored sum.
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

// WHIT-349 adversarial gaps — the WHIT-357 remainder plug ([G1] posted/pending clamp, [G8] dropped
// net-negative mid-parent, [G9] inert on a reconciling subtree), the never-rendered-parent refund
// guard [G2], the fully-refunded-parent orphan [G3], multi-level mid-parent refunds [G4]/[G7], and
// uncategorized-coexists-with-refund [G5]. Uses factory's withRollup (same __rollup__ write).
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

// ===== WHIT-353 (folded from breakdownColdCache.gaps.logic.test.ts) — categoryBreakdown after
// computeCombined + the rollup fallback were deleted. The selector defaults a MISSING __rollup__ to
// `{ nodes: {} }`; these pin the cold-cache path that used to hit the deleted fallback: a cold `{}`
// cache, a missing __rollup__ over a TREE (every parent reads zero -> dropped), and a parent whose
// flat children are all absent collapsing to a leaf reading its own flat value. readRollup /
// ROLLUP_KEY imports merged into the survivor's context import above. FOOD_TREE is gaps-only.
const FOOD_TREE = [
  cat({ id: 'food', name: 'Food', bucket: 'Living', parent: null }),
  cat({ id: 'groceries', name: 'Groceries', bucket: 'Living', parent: 'food' }),
  cat({ id: 'restaurants', name: 'Restaurants', bucket: 'Living', parent: 'food' }),
];

describe('categoryBreakdown — cold cache / missing __rollup__ (WHIT-353)', () => {
  it('[QA1] a cold {} cache has no __rollup__ -> readRollup undefined, empty rows/total, no throw', () => {
    // The ONLY missing-key case the plan claims is a cold cache before first fetch (the
    // in-memory query cache isn't persisted -> cold == {}). readRollup must return undefined and
    // the `?? { nodes: {} }` default must render nothing without throwing.
    const s = makeState({ categories: FOOD_TREE, breakdown: {} });
    expect(readRollup(s.breakdown)).toBeUndefined();
    let out!: ReturnType<typeof categoryBreakdown>;
    expect(() => { out = categoryBreakdown(s); }).not.toThrow();
    expect(out.rows).toEqual([]);
    expect(out.total).toBe(0);
  });

  it('[QA2] missing __rollup__ + a TREE breakdown: every parent reads the empty default -> DROPPED', () => {
    // A pre-WHIT-358 server (or any response missing the key) that still carries flat child keys.
    // Old code: computeCombined summed groceries+restaurants -> Food rendered 140. New code:
    // nodes = {} (the default), Food.isParent so comb = nodes['food'] ?? ZERO = ZERO -> Food is
    // DROPPED, its children become depth-1 orphans (parent never shown), hero = 0. This PINS the
    // user-visible divergence from the deleted fallback: a mid-first-load tree user would see an
    // EMPTY Insights screen for such a response. It must at least not CRASH.
    const s = makeState({
      categories: FOOD_TREE,
      breakdown: { groceries: spend({ posted: 80, pending: 0 }), restaurants: spend({ posted: 60, pending: 0 }) },
    });
    expect(readRollup(s.breakdown)).toBeUndefined();          // genuinely no rollup key
    let out!: ReturnType<typeof categoryBreakdown>;
    expect(() => { out = categoryBreakdown(s); }).not.toThrow();  // rollup.nodes on the {nodes:{}} default is safe; nodes['food'] then reads undefined -> ZERO
    const { rows, total } = out;
    expect(rows.find((r) => r.id === 'food')).toBeUndefined();    // no combined parent (fallback deleted)
    expect(rows.filter((r) => r.depth === 0)).toEqual([]);        // nothing top-level
    expect(total).toBe(0);                                        // hero shows $0, NOT the old 140
  });

  it('[QA3] a parent whose flat children are ALL absent collapses to a LEAF reading its own flat value', () => {
    // The WHIT-358 server drops zero-spend child keys. Food carries only its OWN flat spend (30);
    // its node says 30 too. With no present children Food is NOT a parent -> it reads direct (30),
    // not the node. To PROVE which is read, the node deliberately DIFFERS (99): the leaf must show
    // 30 (direct), never 99 (node). Fail-on-revert: if isParent were keyed on node presence, 99.
    const s = makeState({
      categories: FOOD_TREE,
      breakdown: withRollup(
        { food: spend({ posted: 30, pending: 0 }) },       // only the parent's own flat key survives
        { nodes: { food: { posted: 99, pending: 0 } } },   // node differs — must NOT be read for a leaf
      ),
    });
    const { rows, total } = categoryBreakdown(s);
    const food = rows.find((r) => r.id === 'food')!;
    expect(food).toMatchObject({ spent: 30, depth: 0, hasChildren: false });  // leaf, own flat value
    expect(total).toBe(30);
  });
});

// ===== WHIT-357 (folded from breakdownRemainderGaps.logic.test.ts) — QA GAP tests for the
// synthetic "Other" remainder plug: a genuine sub-cent residual not swallowed by the 0.005 epsilon,
// pure float-dust producing NO phantom row, 3-level nesting where the inner remainder is not
// double-counted at the outer level, emit position (contiguous under its parent), and the plug row's
// neutral display-only styling. NOTE: this gaps file declares its OWN CAR_TREE (car/petrol/SNACKS)
// which DIFFERS from the survivor's CAR_TREE (car/petrol/TOLLS), so its whole block is wrapped in an
// outer describe with a block-scoped CAR_TREE that shadows without redeclaring at module scope.
describe('WHIT-357 remainder GAPs (folded)', () => {
  const CAR_TREE = [
    cat({ id: 'car', name: 'Car', bucket: 'Living', parent: null }),
    cat({ id: 'petrol', name: 'Petrol', bucket: 'Living', parent: 'car' }),
    cat({ id: 'snacks', name: 'Snacks', bucket: 'Living', parent: 'car' }),
  ];

  describe('categoryBreakdown — WHIT-357 remainder GAPs', () => {
    it('[G10] a genuine sub-cent residual (node 10.00 vs child 9.99) is plugged, not swallowed by the epsilon', () => {
      // The 0.005 guard exists to eat float dust, NOT a real one-cent gap. node car = 10.00 exactly,
      // its only child petrol floors to 9.99 -> a real 0.01 residual (>= 0.005) MUST get an "Other" line
      // so the expanded rows still sum to the cent. Fail-on-revert: drop the plug loop and car__remainder
      // is undefined -> this test errors.
      const s = makeState({
        categories: [
          cat({ id: 'car', name: 'Car', bucket: 'Living', parent: null }),
          cat({ id: 'petrol', name: 'Petrol', bucket: 'Living', parent: 'car' }),
        ],
        breakdown: withRollup(
          { petrol: spend({ posted: 9.99, pending: 0 }) },
          { nodes: { car: { posted: 10, pending: 0 } } },
        ),
      });
      const { rows, total } = categoryBreakdown(s);
      const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
      expect(byId['car'].spent).toBe(10);
      expect(byId['petrol'].spent).toBeCloseTo(9.99, 5);
      expect(byId['car__remainder']).toMatchObject({ isRemainder: true, parentId: 'car', depth: 1, pct: 0, name: 'Pending/refund adjustment' });
      expect(byId['car__remainder'].spent).toBeCloseTo(0.01, 5);
      // Reconciles to the cent: petrol (9.99) + Other (0.01) == car node (10.00).
      expect(byId['petrol'].spent + byId['car__remainder'].spent).toBeCloseTo(10, 5);
      expect(total).toBe(10);   // remainder is depth 1 -> never in the hero
    });

    it('[G11] pure float-dust (0.1 + 0.2 vs a 0.3 node) produces NO phantom "Other" row', () => {
      // childSum = 0.1 + 0.2 = 0.30000000000000004 in IEEE-754, so parentNode(0.3) - childSum is
      // ~ -5.6e-17. abs(...) < 0.005 MUST short-circuit -> no synthetic row, no $0-ish "Other" phantom.
      // Fail-on-revert: widen the epsilon to 0 (`< 0`) and this float dust emits a bogus row -> fails.
      const s = makeState({
        categories: CAR_TREE,
        breakdown: withRollup(
          { petrol: spend({ posted: 0.1, pending: 0 }), snacks: spend({ posted: 0.2, pending: 0 }) },
          { nodes: { car: { posted: 0.3, pending: 0 } } },
        ),
      });
      const { rows } = categoryBreakdown(s);
      expect(rows.some((r) => r.isRemainder)).toBe(false);          // no phantom
      expect(rows.find((r) => r.id === 'car__remainder')).toBeUndefined();
      expect(rows.find((r) => r.id === 'car')!.spent).toBe(0.3);    // node unchanged
    });

    it('[G12] 3-level: a SURVIVING inner parent AND its outer parent each plug; the inner remainder is not double-counted', () => {
      // car > travel > taxi, all surviving. Nodes are fixed: travel = 30, taxi floors to 40 -> travel
      // needs a -10 plug. car = 50; car's only child is the travel NODE (30), so car needs a +20 plug.
      // The KEY adversarial point: car's childSum reads travel's NODE (30), NOT taxi(40) or travel's own
      // -10 plug — so the inner remainder is reconciled once, under travel, and never leaks up to car.
      // Fail-on-revert: drop the plug loop -> neither __remainder row exists -> this test errors.
      const s = makeState({
        categories: [
          cat({ id: 'car', name: 'Car', bucket: 'Living', parent: null }),
          cat({ id: 'travel', name: 'Travel', bucket: 'Living', parent: 'car' }),
          cat({ id: 'taxi', name: 'Taxi', bucket: 'Living', parent: 'travel' }),
        ],
        breakdown: withRollup(
          { taxi: spend({ posted: 40, pending: 0 }) },
          { nodes: { car: { posted: 50, pending: 0 }, travel: { posted: 30, pending: 0 } } },
        ),
      });
      const { rows, total } = categoryBreakdown(s);
      const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
      expect(byId['taxi'].spent).toBe(40);
      expect(byId['travel']).toMatchObject({ spent: 30, depth: 1, parentId: 'car' });
      expect(byId['car']).toMatchObject({ spent: 50, depth: 0 });
      // Inner plug: -10 under travel, at depth 2.
      expect(byId['travel__remainder']).toMatchObject({ spent: -10, isRemainder: true, parentId: 'travel', depth: 2 });
      // Outer plug: +20 under car, at depth 1.
      expect(byId['car__remainder']).toMatchObject({ spent: 20, isRemainder: true, parentId: 'car', depth: 1 });
      // Inner reconciles: taxi (40) + Other (-10) == travel node (30).
      expect(byId['taxi'].spent + byId['travel__remainder'].spent).toBe(30);
      // Outer reconciles from the NODE only: travel node (30) + Other (20) == car node (50).
      // If the inner remainder (-10) or taxi (40) were double-counted here, this would not hold.
      expect(byId['travel'].spent + byId['car__remainder'].spent).toBe(50);
      expect(total).toBe(50);   // only car is depth 0
    });

    it('[G13] the "Other" row lands contiguously under its parent (not detached at the end), before the next depth-0 sibling', () => {
      // car (node 100) with petrol (100) + a tolls refund (-30) needs a +30 plug; a separate top-level
      // groceries leaf (50) sorts AFTER car. The plug must be emitted DURING car's depth-first subtree
      // (grouped with petrol/refund, sorted by spent desc), NOT swept to the very end after groceries —
      // otherwise the screen would render a stray "Other" under the wrong row. Fail-on-revert: without
      // pushEmit(parentId, remainderId) the row is only reached by the trailing key-sweep -> it lands
      // last, after groceries -> this ordering assertion fails.
      const s = makeState({
        categories: [
          cat({ id: 'car', name: 'Car', bucket: 'Living', parent: null }),
          cat({ id: 'petrol', name: 'Petrol', bucket: 'Living', parent: 'car' }),
          cat({ id: 'tolls', name: 'Tolls', bucket: 'Living', parent: 'car' }),
          cat({ id: 'groceries', name: 'Groceries', bucket: 'Living', parent: null }),
        ],
        breakdown: withRollup(
          { petrol: spend({ posted: 100, pending: 0 }), tolls: spend({ posted: 0, pending: 0 }), groceries: spend({ posted: 50, pending: 0 }) },
          { nodes: { car: { posted: 100, pending: 0 } }, refunds: { car: [{ id: 'tolls', amount: -30 }] } },
        ),
      });
      const { rows } = categoryBreakdown(s);
      const ids = rows.map((r) => r.id);
      // Depth-first, siblings by spent desc: car, [petrol 100, Other +30, refund -30], groceries.
      expect(ids).toEqual(['car', 'petrol', 'car__remainder', 'tolls__refund', 'groceries']);
      // Contiguity guards, in case the sort tie-order ever shifts: the plug sits AFTER car and
      // strictly BEFORE the next depth-0 sibling (groceries), i.e. grouped in car's subtree.
      expect(ids.indexOf('car__remainder')).toBeGreaterThan(ids.indexOf('car'));
      expect(ids.indexOf('car__remainder')).toBeLessThan(ids.indexOf('groceries'));
    });

    it('the plug row is painted neutral (textDim), never a donut/pct slice — pins the display-only contract', () => {
      // Same shape as [G1] but asserting the presentation fields the screen keys off: neutral colour,
      // sliders icon, pct 0. Fail-on-revert on the plug loop removes the row entirely -> this errors.
      const s = makeState({
        categories: CAR_TREE,
        breakdown: withRollup(
          { petrol: spend({ posted: 100, pending: 0 }), snacks: spend({ posted: 0, pending: 0 }) },
          { nodes: { car: { posted: 100, pending: 0 } }, refunds: { car: [{ id: 'snacks', amount: -30 }] } },
        ),
      });
      const { rows } = categoryBreakdown(s);
      const other = rows.find((r) => r.id === 'car__remainder')!;
      expect(other).toMatchObject({ isRemainder: true, color: C.textDim, icon: 'sliders', pct: 0, hasChildren: false });
    });
  });
});
