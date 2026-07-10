// WHIT-221 — budgetViews sub-category tree: ADVERSARIAL GAP tests the implementer's
// budget.logic.test.ts does NOT cover. Focus: multi-family independence, the exact
// child-before-parent ordering the two-pass exists to fix, depth-first emission with
// multiple children + a grandchild, a parent with all subs un-budgeted, and a
// Savings parent/sub pair (both skipped, no crash). Pure — runs headlessly.
import { describe, it, expect } from '@jest/globals';
import { budgetViews } from '../context';
import { makeState, cat, budget } from './factory';

describe('budgetViews sub-category tree — gaps (WHIT-221)', () => {
  // [A20] The exact bug the two-pass prevents: a budgeted sub sorts BEFORE its
  // budgeted parent in budgets[]. A single build-as-you-go pass would not yet know
  // the parent is budgeted when it hits the sub, count the sub at depth 0, and
  // double-count the family. Pass 1 (build budgetedRowIds up front) must prevent that.
  it('de-dups even when the sub sorts BEFORE its parent in budgets[]', () => {
    const s = makeState({
      categories: [cat({ id: 'car', name: 'Car', bucket: 'Living', parent: null }),
                   cat({ id: 'parking', name: 'Parking', bucket: 'Living', parent: 'car' })],
      // parking (the CHILD) listed first — the ordering that breaks a naive one-pass.
      budgets: [budget({ id: 'parking', budget: 50, posted: 30, pending: 0 }),
                budget({ id: 'car', budget: 200, posted: 75, pending: 0 })],
      cycleLen: 14, daysLeft: 7,
    });
    const { rows, totSpent, totBudget, totRemain } = budgetViews(s);
    expect(totSpent).toBe(75);   // Car only; NOT 75 + 30 = 105
    expect(totBudget).toBe(200); // Car only; NOT 250
    expect(totRemain).toBe(125);
    // Emitted parent-first regardless of the incoming child-first order.
    expect(rows.map((r) => r.id)).toEqual(['car', 'parking']);
    expect(rows[0]).toMatchObject({ id: 'car', depth: 0, parentId: null });
    expect(rows[1]).toMatchObject({ id: 'parking', depth: 1, parentId: 'car' });
  });

  // [A21] Two independent parent+sub families. Each must de-dup on its own; the hero
  // sums the two parents only, never a sub.
  it('de-dups two separate families independently and sums both parents', () => {
    const s = makeState({
      categories: [cat({ id: 'car', name: 'Car', bucket: 'Living', parent: null }),
                   cat({ id: 'parking', name: 'Parking', bucket: 'Living', parent: 'car' }),
                   cat({ id: 'food', name: 'Food', bucket: 'Living', parent: null }),
                   cat({ id: 'snacks', name: 'Snacks', bucket: 'Living', parent: 'food' })],
      budgets: [budget({ id: 'car', budget: 200, posted: 75, pending: 0 }),
                budget({ id: 'parking', budget: 50, posted: 30, pending: 0 }),
                budget({ id: 'food', budget: 400, posted: 120, pending: 0 }),
                budget({ id: 'snacks', budget: 60, posted: 40, pending: 0 })],
      cycleLen: 14, daysLeft: 7,
    });
    const { rows, totSpent, totBudget, totRemain } = budgetViews(s);
    expect(totSpent).toBe(75 + 120);   // both parents, neither sub
    expect(totBudget).toBe(200 + 400);
    expect(totRemain).toBe((200 - 75) + (400 - 120));
    // Each family emitted contiguously, parent then child.
    expect(rows.map((r) => [r.id, r.depth])).toEqual([
      ['car', 0], ['parking', 1], ['food', 0], ['snacks', 1],
    ]);
  });

  // [A22] Depth-first emission with two children AND a grandchild. Order must be
  // parent → child1 → grandchild(of child1) → child2, with depths 0,1,2,1.
  it('emits depth-first: parent, child1, grandchild, child2 (multi-child + grandchild)', () => {
    const s = makeState({
      categories: [cat({ id: 'car', name: 'Car', bucket: 'Living', parent: null }),
                   cat({ id: 'daily', name: 'Daily', bucket: 'Living', parent: 'car' }),
                   cat({ id: 'petrol', name: 'Petrol', bucket: 'Living', parent: 'daily' }),
                   cat({ id: 'parking', name: 'Parking', bucket: 'Living', parent: 'car' })],
      budgets: [budget({ id: 'car', budget: 300, posted: 100, pending: 0 }),
                budget({ id: 'daily', budget: 100, posted: 50, pending: 0 }),
                budget({ id: 'petrol', budget: 40, posted: 20, pending: 0 }),
                budget({ id: 'parking', budget: 50, posted: 30, pending: 0 })],
      cycleLen: 14, daysLeft: 7,
    });
    const { rows, totSpent } = budgetViews(s);
    expect(rows.map((r) => [r.id, r.depth])).toEqual([
      ['car', 0], ['daily', 1], ['petrol', 2], ['parking', 1],
    ]);
    expect(totSpent).toBe(100); // only Car (top of the single family)
  });

  // [A23] A parent budgeted but ALL its subs un-budgeted: parent shows, no child
  // rows, hero counts the parent exactly once (nothing to de-dup, nothing dropped).
  it('a budgeted parent with all subs un-budgeted shows one row and counts once', () => {
    const s = makeState({
      categories: [cat({ id: 'car', name: 'Car', bucket: 'Living', parent: null }),
                   cat({ id: 'parking', name: 'Parking', bucket: 'Living', parent: 'car' }),
                   cat({ id: 'petrol', name: 'Petrol', bucket: 'Living', parent: 'car' })],
      budgets: [budget({ id: 'car', budget: 200, posted: 75, pending: 0 })],
      cycleLen: 14, daysLeft: 7,
    });
    const { rows, totSpent, totBudget } = budgetViews(s);
    expect(rows.map((r) => r.id)).toEqual(['car']);
    expect(rows[0]).toMatchObject({ depth: 0, parentId: null });
    expect(totSpent).toBe(75);
    expect(totBudget).toBe(200);
  });

  // [A24] A Savings parent with a Savings sub: BOTH skipped (row + totals), no crash,
  // no orphaned child row. Guards the Savings-skip interacting with the tree walk.
  it('skips a Savings parent AND its Savings sub entirely (no row, no crash)', () => {
    const s = makeState({
      categories: [cat({ id: 'nest', name: 'Nest Egg', bucket: 'Savings', parent: null }),
                   cat({ id: 'holiday', name: 'Holiday', bucket: 'Savings', parent: 'nest' })],
      budgets: [budget({ id: 'nest', budget: 2000, posted: 0, pending: 0 }),
                budget({ id: 'holiday', budget: 500, posted: 0, pending: 0 })],
      cycleLen: 14, daysLeft: 7,
    });
    const { rows, totSpent, totBudget, totRemain } = budgetViews(s);
    expect(rows).toHaveLength(0);
    expect(totSpent).toBe(0);
    expect(totBudget).toBe(0);
    expect(totRemain).toBe(0);
  });

  // [A25] A spend sub with a CROSS-BUCKET budgeted ancestor (a Living sub under a
  // budgeted Income parent — only reachable via legacy/corrupt data; the server's
  // same-bucket rule blocks it on write). The de-dup only skips a row that has a
  // SAME-BUCKET budgeted ancestor, so this spend sub is NOT dropped: it counts once
  // on its own (depth 0). Fail-on-revert: removing the same-bucket check in
  // walkBudgetedAncestors makes `odd` depth 1 and silently drops its £40 from the hero.
  it('counts a spend sub whose only budgeted ancestor is a different bucket (no silent drop)', () => {
    const s = makeState({
      categories: [cat({ id: 'income', name: 'Income', bucket: 'Income', parent: null }),
                   cat({ id: 'odd', name: 'Odd Spend', bucket: 'Living', parent: 'income' })],
      budgets: [budget({ id: 'income', budget: 5000, posted: 4000, pending: 0 }),
                budget({ id: 'odd', budget: 100, posted: 40, pending: 0 })],
      cycleLen: 14, daysLeft: 7,
    });
    const { rows, totSpent, totBudget } = budgetViews(s);
    // The spend sub counts once (Income parent is excluded from the spend hero by bucket).
    expect(totSpent).toBe(40);
    expect(totBudget).toBe(100);
    // and it renders at the top level, not nested under the Income row.
    expect(rows.find((r) => r.id === 'odd')).toMatchObject({ depth: 0, parentId: null });
  });
});
