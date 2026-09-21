// WHIT-348 unit edges for budgetSubtreeContains — the client mirror of the server's subtree_ids.
// The full cross-product parity vs the server rule lives in budgetSubtreeParity.logic.test.ts;
// this file pins the individual branches with a hand-built tree so a failure names the exact case.
import { describe, it, expect } from '@jest/globals';
import { budgetSubtreeContains } from '../context';
import type { Category } from '../context';

// Minimal Category; only id/parent/bucket drive the rule.
const cat = (id: string, parent: string | null, bucket: string): Category =>
  ({ id, name: id, icon: 'q', color: '#fff', bucket: bucket as Category['bucket'], recent: 0, parent });

// car(Living) → parking(Living); car → odd(Lifestyle) → deep(Living); car → nest(Savings).
// income(Lifestyle) is unrelated. loopA↔loopB is a corrupt two-node cycle (both Living).
const CATS: Category[] = [
  cat('car', null, 'Living'),
  cat('parking', 'car', 'Living'),
  cat('odd', 'car', 'Lifestyle'),
  cat('deep', 'odd', 'Living'),
  cat('nest', 'car', 'Savings'),
  cat('income', null, 'Lifestyle'),
  cat('loopA', 'loopB', 'Living'),
  cat('loopB', 'loopA', 'Living'),
];

describe('budgetSubtreeContains (WHIT-348)', () => {
  it('the root is always in its own subtree', () => {
    expect(budgetSubtreeContains(CATS, 'car', 'car')).toBe(true);
  });

  it('a same-bucket direct child is contained', () => {
    expect(budgetSubtreeContains(CATS, 'car', 'parking')).toBe(true);
  });

  it('a same-bucket descendant UNDER a cross-bucket intermediate is contained (endpoints only)', () => {
    // car(Living) → odd(Lifestyle) → deep(Living): the walk passes through the Lifestyle node,
    // and deep is kept because deep and car share the Living bucket.
    expect(budgetSubtreeContains(CATS, 'car', 'deep')).toBe(true);
  });

  it('a cross-bucket direct child is NOT contained', () => {
    expect(budgetSubtreeContains(CATS, 'car', 'odd')).toBe(false);
  });

  it('a Savings child of a Living budget is NOT contained', () => {
    expect(budgetSubtreeContains(CATS, 'car', 'nest')).toBe(false);
  });

  it('an ancestor is not contained by its own child (walk is downward-only)', () => {
    expect(budgetSubtreeContains(CATS, 'parking', 'car')).toBe(false);
  });

  it('an unrelated top-level category is not contained', () => {
    expect(budgetSubtreeContains(CATS, 'car', 'income')).toBe(false);
  });

  it('an unknown categoryId is not contained (unless it equals the budget id)', () => {
    expect(budgetSubtreeContains(CATS, 'car', 'ghost')).toBe(false);
    expect(budgetSubtreeContains(CATS, 'ghost', 'ghost')).toBe(true); // root-equality short-circuit
  });

  it('a corrupt parent cycle terminates and returns a boolean (no hang)', () => {
    expect(budgetSubtreeContains(CATS, 'loopA', 'loopB')).toBe(true);   // loopB → loopA reaches the root
    expect(budgetSubtreeContains(CATS, 'car', 'loopA')).toBe(false);    // the cycle is unrelated to car
  });
});

// WHIT-348 adversarial gaps — an independent null-bucket ("None == None") DEEP oracle the frozen
// parity fixture can't give, plus a model/property test: an INDEPENDENT down-walk oracle (re-derived
// from the server rule, not the production code) checked against the client up-walk on many random
// trees + cycles, so a client drift reddens even if the golden fixture were regenerated.

// bucket may be null here (a corrupt/absent-bucket row); the production rule compares buckets with
// ===, mirroring the server's `None == None`, so cast through unknown like the parity fixture does.
type LooseCat = { id: string; parent: string | null; bucket: string | null };
const asCats = (cs: LooseCat[]): Category[] => cs as unknown as Category[];

describe('budgetSubtreeContains — null-bucket DEEP case, independent of the frozen fixture (WHIT-348)', () => {
  // none_root(null) → mid(Living) → leaf(null). The server keeps `leaf` under `none_root` because
  // both endpoints are None (None == None), descending THROUGH the Living intermediate. The parity
  // fixture only has a null child DIRECTLY under a null root — never one reached through a non-null
  // node — so this branch of the client rule is otherwise pinned by the golden file alone.
  const TREE = asCats([
    { id: 'none_root', parent: null, bucket: null },
    { id: 'mid', parent: 'none_root', bucket: 'Living' },
    { id: 'leaf', parent: 'mid', bucket: null },
    { id: 'mid_null', parent: 'none_root', bucket: null }, // direct null child (control)
  ]);

  it('keeps a null-bucket leaf under a non-null intermediate (None == None, endpoints only)', () => {
    expect(budgetSubtreeContains(TREE, 'none_root', 'leaf')).toBe(true);
  });

  it('drops the non-null intermediate itself from the null-bucket root', () => {
    expect(budgetSubtreeContains(TREE, 'none_root', 'mid')).toBe(false);
  });

  it('keeps a direct null child of a null root', () => {
    expect(budgetSubtreeContains(TREE, 'none_root', 'mid_null')).toBe(true);
  });

  it('a Living budget does NOT own a null-bucket descendant (null !== Living)', () => {
    // Symmetric to the server: with a real-bucket root, a None descendant is excluded.
    const t = asCats([
      { id: 'car', parent: null, bucket: 'Living' },
      { id: 'ghost', parent: 'car', bucket: null },
    ]);
    expect(budgetSubtreeContains(t, 'car', 'ghost')).toBe(false);
  });
});

// --- Model/property test: UP-walk (client) vs DOWN-walk (server rule) on every generated tree ---

// The server rule, re-implemented from its docstring (shared/spend.py subtree_ids): descend from
// root over the parent-inverse child map collecting `visited`, then keep a node iff it IS the root
// OR its bucket equals the root's bucket (an absent bucket compares as null == null). This is an
// INDEPENDENT oracle of the requirement — not a copy of budgetSubtreeContains — so a client-side
// drift reddens against it (and, unlike the golden fixture, it is re-derived per run, so no
// regeneration can silence it).
function subtreeIdsOracle(cats: LooseCat[], rootId: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const c of cats) {
    if (c.parent != null) {
      const kids = children.get(c.parent) ?? [];
      kids.push(c.id);
      children.set(c.parent, kids);
    }
  }
  const bucketOf = new Map(cats.map((c) => [c.id, c.bucket]));
  const visited = new Set<string>();
  const stack = [rootId];
  while (stack.length) {
    const node = stack.pop()!;
    if (visited.has(node)) continue;
    visited.add(node);
    for (const kid of children.get(node) ?? []) stack.push(kid);
  }
  const rootBucket = bucketOf.get(rootId) ?? null; // absent root → null, mirroring dict.get -> None
  const out = new Set<string>();
  for (const node of visited) {
    if (node === rootId || (bucketOf.get(node) ?? null) === rootBucket) out.add(node);
  }
  return out;
}

// Deterministic LCG (no ambient Math.random — anti-flake, reproducible on any box/TZ).
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
}

const BUCKETS: (string | null)[] = ['Living', 'Lifestyle', 'Savings', null];

// Build a random taxonomy of `n` nodes. Most parents point at a LOWER index (a valid single-parent
// forest); with small probability a parent points anywhere, which can forge a corrupt cycle — the
// exact shape both rules must survive. Buckets (incl. null) are random so the endpoint-bucket rule
// is exercised across the board.
function randomTree(rand: () => number, n: number): LooseCat[] {
  const cats: LooseCat[] = [];
  for (let i = 0; i < n; i++) {
    const r = rand();
    let parent: string | null;
    if (r < 0.28) parent = null;
    else if (r < 0.9 && i > 0) parent = 'n' + Math.floor(rand() * i);       // acyclic (lower index)
    else parent = 'n' + Math.floor(rand() * n);                             // may form a cycle
    if (parent === 'n' + i) parent = null;                                  // drop only a trivial self-loop
    cats.push({ id: 'n' + i, parent, bucket: BUCKETS[Math.floor(rand() * BUCKETS.length)] });
  }
  return cats;
}

// A node that reaches itself by walking parents = a corrupt cycle (what `seen`/`visited` must survive).
function hasCycle(cats: LooseCat[]): boolean {
  const byId = new Map(cats.map((c) => [c.id, c]));
  return cats.some((c) => {
    let cur: string | null = c.parent;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      if (cur === c.id) return true;
      seen.add(cur);
      cur = byId.get(cur)?.parent ?? null;
    }
    return false;
  });
}

describe('budgetSubtreeContains — UP-walk equals the DOWN-walk oracle on every random tree (WHIT-348)', () => {
  it('agrees on the full budgetId x categoryId cross-product across 400 random trees (incl. cycles)', () => {
    const rand = lcg(0x1348);
    let checks = 0;
    let sawCycle = false;
    for (let t = 0; t < 400; t++) {
      const n = 2 + Math.floor(rand() * 7); // 2..8 nodes
      const cats = randomTree(rand, n);
      const cast = asCats(cats);
      const ids = cats.map((c) => c.id);
      for (const budgetId of ids) {
        const oracle = subtreeIdsOracle(cats, budgetId);
        for (const categoryId of ids) {
          const expected = oracle.has(categoryId);
          const got = budgetSubtreeContains(cast, budgetId, categoryId);
          if (got !== expected) {
            throw new Error(
              `DRIFT on tree ${JSON.stringify(cats)} budget=${budgetId} cat=${categoryId}: `
              + `client=${got} oracle=${expected}`,
            );
          }
          checks++;
        }
      }
      if (!sawCycle) sawCycle = hasCycle(cats);
    }
    expect(checks).toBeGreaterThan(3000); // the sweep actually ran
    expect(sawCycle).toBe(true);          // and it did hit corrupt-cycle shapes
  });
});
