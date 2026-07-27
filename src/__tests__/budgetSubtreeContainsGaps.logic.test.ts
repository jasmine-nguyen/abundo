// WHIT-348 — adversarial gaps for budgetSubtreeContains (the client mirror of the server's
// subtree_ids, shared/spend.py). The implementer's budgetSubtreeContains.logic.test.ts pins the
// named branches on a hand tree, and budgetSubtreeParity.logic.test.ts pins the client to a FROZEN
// golden fixture. A frozen fixture can hide a CO-DRIFT (both rules regenerated wrong together), and
// its taxonomy omits some shapes (a null-bucket descendant reached THROUGH a non-null intermediate,
// deep same-bucket chains). This file adds two things the fixture can't give:
//   1. Independent hardcoded truth for the null-bucket ("None == None") DEEP case — an oracle the
//      client rule is checked against WITHOUT reading the fixture, so client null-drift reddens even
//      if the golden file were regenerated.
//   2. A model/property test: an INDEPENDENT down-walk oracle (re-derived from the server's
//      documented rule, not the production code) over many random trees + cycles, asserting the
//      client UP-walk agrees on the FULL cross-product. This proves the UP-walk == DOWN-walk
//      equivalence "on every tree" rather than on 13 frozen rows.
import { describe, it, expect } from '@jest/globals';
import { budgetSubtreeContains } from '../context';
import type { Category } from '../context';

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
