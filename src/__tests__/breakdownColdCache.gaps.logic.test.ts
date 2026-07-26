// WHIT-353 — QA GAP tests: categoryBreakdown after computeCombined + the rollup fallback were
// deleted. The selector now defaults a MISSING __rollup__ to `{ nodes: {} }` and reads server
// nodes for every parent. The implementer's migrated tests all feed an EXPLICIT __rollup__
// (via withRollup); NONE feed a breakdown with a PARENT and NO __rollup__ key at all — the
// cold-cache path that used to hit the deleted computeCombined fallback. These pin that path.
//
//   [QA1] cold `{}` cache -> readRollup undefined, empty rows/total, no throw          (net-new micro-assert)
//   [QA2] missing __rollup__ + a TREE breakdown -> the default `{nodes:{}}` makes every
//         parent read ZERO -> DROPPED (the fallback's combined parent is GONE). Documents the
//         user-visible divergence from the deleted fallback; also proves nodes[id] on the empty
//         default does not throw.                                                       (net-new)
//   [QA3] a parent whose flat children are ALL absent (server dropped zero-spend keys) collapses
//         to a LEAF reading its OWN flat value — it does NOT read the node.              (net-new)
import { describe, it, expect } from '@jest/globals';
import { categoryBreakdown, readRollup, ROLLUP_KEY } from '../context';
import { makeState, cat, spend, withRollup } from './factory';

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
