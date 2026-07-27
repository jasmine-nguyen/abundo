// WHIT-357 — QA GAP tests for the synthetic "Other" remainder plug in categoryBreakdown.
// The implementer's breakdownRollupGaps.logic.test.ts already locks:
//   [G1] posted-surplus/pending-refund plugged (+30) AND both refund + remainder under one parent,
//   [G8] a dropped net-negative mid-parent plugged (-40) at its grandparent,
//   [G9] a subtree that already sums gets NO plug (the fix is inert on the happy path).
// These add the ADVERSARIAL edges the 3 above don't reach:
//   [G10] a genuine sub-cent residual (10.00 vs 9.99) is NOT swallowed by the 0.005 epsilon,
//   [G11] pure float-dust (0.1 + 0.2 vs 0.3) produces NO phantom "Other" row,
//   [G12] 3-level nesting: a SURVIVING inner parent AND its outer parent each plug, and the inner
//         remainder is NOT double-counted at the outer level (outer sums the inner NODE, not its kids),
//   [G13] emit position: the `${parent}__remainder` row lands contiguously UNDER its parent in the
//         depth-first `rows` output (not detached at the end) and ahead of the next depth-0 sibling.
import { describe, it, expect } from '@jest/globals';
import { categoryBreakdown } from '../context';
import { C } from '../theme';
import { makeState, cat, spend, withRollup } from './factory';

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
