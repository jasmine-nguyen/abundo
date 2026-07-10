// WHIT-226 — categoryBreakdown selector: adversarial GAPS the implementer's
// breakdown.logic tests miss. They lock parent rollup, the de-dup total, the
// synthetic "Directly in" row's PRESENCE, 3-level depths, cross-bucket, and cycle
// termination. This file adds the value-level edges they leave open:
//   [A14] a parent with ONLY zero-spend subs collapses to a plain leaf (no chevron,
//         no synthetic row); a parent with no direct + all-zero subs emits nothing
//   [A15] a combined parent preserves the posted-vs-pending SPLIT (drives the two-tone
//         bar) and surfaces the pending portion in spentLabel — not just the total
//   [A16] the synthetic "Directly in <parent>" row's pct is its OWN share of the grand
//         total, and no row's pct exceeds 100 in a well-formed tree
import { describe, it, expect } from '@jest/globals';
import { categoryBreakdown } from '../context';
import { makeState, cat, spend } from './factory';

describe('categoryBreakdown — tree value edges (WHIT-226)', () => {
  // [A14] zero-spend subs must not fabricate an expandable parent or a $0 sub row.
  it('[A14] a parent whose subs are all zero-spend renders as a plain leaf', () => {
    const s = makeState({
      categories: [
        cat({ id: 'food', name: 'Food', bucket: 'Living', parent: null }),
        cat({ id: 'groceries', name: 'Groceries', bucket: 'Living', parent: 'food' }),
        cat({ id: 'restaurants', name: 'Restaurants', bucket: 'Living', parent: 'food' }),
      ],
      breakdown: {
        food: spend({ posted: 50, pending: 0 }),        // only the parent has spend
        groceries: spend({ posted: 0, pending: 0 }),    // zero → filtered out
        restaurants: spend({ posted: 0, pending: 0 }),  // zero → filtered out
      },
    });
    const { rows, total } = categoryBreakdown(s);
    expect(rows.map((r) => r.id)).toEqual(['food']);          // no sub rows, no synthetic
    expect(rows[0]).toMatchObject({ spent: 50, hasChildren: false, depth: 0, parentId: null });
    expect(total).toBe(50);
  });

  it('[A14b] a parent with no direct spend and only zero-spend subs emits nothing', () => {
    const s = makeState({
      categories: [
        cat({ id: 'food', name: 'Food', bucket: 'Living', parent: null }),
        cat({ id: 'groceries', name: 'Groceries', bucket: 'Living', parent: 'food' }),
      ],
      breakdown: { groceries: spend({ posted: 0, pending: 0 }) },
    });
    const { rows, total } = categoryBreakdown(s);
    expect(rows).toEqual([]);   // no phantom $0 Food parent
    expect(total).toBe(0);
  });

  // [A15] the parent bar is split posted|pending in the screen via r.posted / r.spent,
  // so a combined parent MUST carry the summed split, not just the total.
  it('[A15] a combined parent preserves the posted/pending split and its label', () => {
    const s = makeState({
      categories: [
        cat({ id: 'food', name: 'Food', bucket: 'Living', parent: null }),
        cat({ id: 'groceries', name: 'Groceries', bucket: 'Living', parent: 'food' }),
        cat({ id: 'restaurants', name: 'Restaurants', bucket: 'Living', parent: 'food' }),
      ],
      breakdown: {
        groceries: spend({ posted: 80, pending: 0 }),
        restaurants: spend({ posted: 40, pending: 20 }),
      },
    });
    const food = categoryBreakdown(s).rows.find((r) => r.id === 'food')!;
    expect(food.posted).toBe(120);      // 80 + 40
    expect(food.pending).toBe(20);      // 0 + 20 — pending rolls up too
    expect(food.spent).toBe(140);
    expect(food.spentLabel).toContain('pending');
    expect(food.spentLabel).toContain('$20');  // the pending portion, surfaced
  });

  // [A16] the synthetic row is a real share of the grand total, and the tree's pcts
  // stay bounded — a parent can't overflow its own bar in a well-formed taxonomy.
  it('[A16] the synthetic "Directly in" row has its own pct share; no pct exceeds 100', () => {
    const s = makeState({
      categories: [
        cat({ id: 'car', name: 'Car', bucket: 'Living', parent: null }),
        cat({ id: 'parking', name: 'Parking', bucket: 'Living', parent: 'car' }),
      ],
      breakdown: {
        car: spend({ posted: 40, pending: 0 }),       // tagged straight on the parent
        parking: spend({ posted: 60, pending: 0 }),
      },
    });
    const { rows, total } = categoryBreakdown(s);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(total).toBe(100);
    expect(byId['car'].pct).toBeCloseTo(100, 5);            // whole tree = whole total
    expect(byId['car__direct'].pct).toBeCloseTo(40, 5);     // its own 40 / 100
    expect(byId['parking'].pct).toBeCloseTo(60, 5);
    // the synthetic + real child pcts reconcile to the parent's pct
    expect(byId['car__direct'].pct + byId['parking'].pct).toBeCloseTo(byId['car'].pct, 5);
    for (const r of rows) expect(r.pct).toBeLessThanOrEqual(100 + 1e-9);
  });
});
