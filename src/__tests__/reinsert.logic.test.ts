// WHIT-254 — the pure reinsert helper the optimistic-delete rollbacks use. Runs in the fast
// `logic` project (no RN graph) so the concurrent-delete ordering can be exercised without the
// provider harness. Each concurrent case applies BOTH rollbacks to the optimistic list in BOTH
// resolution orders and asserts the original order is restored either way — a saved integer
// index (the old code) fails these.
import { describe, it, expect } from '@jest/globals';
import { reinsertBefore } from '../reinsert';

type Row = { id: string };
const rows = (...ids: string[]): Row[] => ids.map((id) => ({ id }));
const ids = (list: Row[]) => list.map((x) => x.id);

describe('reinsertBefore — single reinsert', () => {
  it('inserts before the first surviving successor (a middle row)', () => {
    // b removed from [a,b,c,d]; successors [c,d]; put back into [a,c,d].
    expect(ids(reinsertBefore(rows('a', 'c', 'd'), { id: 'b' }, ['c', 'd']))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('inserts at the front (a first row)', () => {
    expect(ids(reinsertBefore(rows('b', 'c'), { id: 'a' }, ['b', 'c']))).toEqual(['a', 'b', 'c']);
  });

  it('appends when there is no successor (a last row)', () => {
    expect(ids(reinsertBefore(rows('a', 'b'), { id: 'c' }, []))).toEqual(['a', 'b', 'c']);
  });

  it('appends when every successor was also deleted', () => {
    expect(ids(reinsertBefore(rows('b'), { id: 'a' }, ['c']))).toEqual(['b', 'a']);
  });

  it('appends into an empty list (only element, or all successors gone)', () => {
    expect(ids(reinsertBefore([], { id: 'a' }, []))).toEqual(['a']);
    expect(ids(reinsertBefore([], { id: 'a' }, ['z']))).toEqual(['a']);
  });
});

describe('reinsertBefore — concurrent deletes restore order in both interleavings', () => {
  it('a GAP pair: delete(a) + delete(c) from [a,b,c,d]', () => {
    // successorIds captured at delete time (second delete reads the post-remove list):
    // delete(a) -> [b,c,d]; delete(c) -> [d]; optimistic list [b,d].
    const optimistic = rows('b', 'd');
    const rollA = (l: Row[]) => reinsertBefore(l, { id: 'a' }, ['b', 'c', 'd']);
    const rollC = (l: Row[]) => reinsertBefore(l, { id: 'c' }, ['d']);
    expect(ids(rollC(rollA(optimistic)))).toEqual(['a', 'b', 'c', 'd']);
    expect(ids(rollA(rollC(optimistic)))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('an ADJACENT pair: delete(b) + delete(c) from [a,b,c,d] (the case single-neighbour missed)', () => {
    // delete(b) -> [c,d]; delete(c) -> [d]; optimistic list [a,d].
    const optimistic = rows('a', 'd');
    const rollB = (l: Row[]) => reinsertBefore(l, { id: 'b' }, ['c', 'd']);
    const rollC = (l: Row[]) => reinsertBefore(l, { id: 'c' }, ['d']);
    expect(ids(rollB(rollC(optimistic)))).toEqual(['a', 'b', 'c', 'd']);
    expect(ids(rollC(rollB(optimistic)))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('FIRST + LAST deleted together: delete(a) + delete(d) from [a,b,c,d]', () => {
    // delete(a) -> [b,c,d]; delete(d) -> []; optimistic list [b,c].
    const optimistic = rows('b', 'c');
    const rollA = (l: Row[]) => reinsertBefore(l, { id: 'a' }, ['b', 'c', 'd']);
    const rollD = (l: Row[]) => reinsertBefore(l, { id: 'd' }, []);
    expect(ids(rollA(rollD(optimistic)))).toEqual(['a', 'b', 'c', 'd']);
    expect(ids(rollD(rollA(optimistic)))).toEqual(['a', 'b', 'c', 'd']);
  });
});

// ===== WHIT-254 (folded from reinsertEdges.gaps.logic.test.ts) — adversarial edge coverage for
// the pure reinsert helper, beyond the survivor's single reinsert + 2-delete interleavings: THREE
// concurrent rollbacks in EVERY resolution order, a successorIds list padded with absent ids, a
// duplicate-id list, and the double-rollback idempotency question. Type Row + rows()/ids() are
// reused from the survivor above (byte-identical; the gaps file's own duplicates are dropped);
// permutations() is gaps-only and kept at module level.
function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) =>
    permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]),
  );
}

describe('reinsertBefore — THREE concurrent failed deletes restore order in ANY order', () => {
  // From [a,b,c,d,e] delete b,c,d (an adjacent chain). successorIds captured at each
  // delete's removal time (later deletes see the already-shortened list):
  //   del b -> [a,c,d,e]  succ [c,d,e]
  //   del c -> [a,d,e]    succ [d,e]
  //   del d -> [a,e]      succ [e]
  // optimistic list = [a,e]; all three fail; rollbacks may run in any of 6 orders.
  const optimistic = rows('a', 'e');
  const rollbacks = {
    b: (l: Row[]) => reinsertBefore(l, { id: 'b' }, ['c', 'd', 'e']),
    c: (l: Row[]) => reinsertBefore(l, { id: 'c' }, ['d', 'e']),
    d: (l: Row[]) => reinsertBefore(l, { id: 'd' }, ['e']),
  };
  it.each(permutations(['b', 'c', 'd'] as const).map((p) => [p.join('')]))(
    'rollback order %s -> [a,b,c,d,e]',
    (order) => {
      const result = [...order].reduce((l, k) => rollbacks[k as 'b' | 'c' | 'd'](l), optimistic);
      expect(ids(result)).toEqual(['a', 'b', 'c', 'd', 'e']);
    },
  );

  it('a GAP triple (a,c,e from [a,b,c,d,e]) restores in any order', () => {
    // del a -> [b,c,d,e] succ [b,c,d,e]; del c -> [b,d,e] succ [d,e]; del e -> [b,d] succ [].
    const opt = rows('b', 'd');
    const rb = {
      a: (l: Row[]) => reinsertBefore(l, { id: 'a' }, ['b', 'c', 'd', 'e']),
      c: (l: Row[]) => reinsertBefore(l, { id: 'c' }, ['d', 'e']),
      e: (l: Row[]) => reinsertBefore(l, { id: 'e' }, []),
    };
    for (const order of permutations(['a', 'c', 'e'] as const)) {
      const result = [...order].reduce((l, k) => rb[k as 'a' | 'c' | 'e'](l), opt);
      expect(ids(result)).toEqual(['a', 'b', 'c', 'd', 'e']);
    }
  });
});

describe('reinsertBefore — malformed / defensive inputs', () => {
  it('skips successor ids that are absent and anchors on the first present one', () => {
    // successorIds carries stale/never-present ids ('x','y') around the real 'c'.
    expect(ids(reinsertBefore(rows('a', 'c', 'd'), { id: 'b' }, ['x', 'c', 'y']))).toEqual(
      ['a', 'b', 'c', 'd'],
    );
  });

  it('anchors before the FIRST occurrence when the list has a duplicate id', () => {
    // Shouldn't happen (ids are unique) but findIndex-first must be deterministic.
    expect(ids(reinsertBefore(rows('a', 'c', 'x', 'c'), { id: 'b' }, ['c']))).toEqual(
      ['a', 'b', 'c', 'x', 'c'],
    );
  });

  it('appends once every named successor is absent, even if the list is non-empty', () => {
    expect(ids(reinsertBefore(rows('p', 'q'), { id: 'b' }, ['gone1', 'gone2']))).toEqual(
      ['p', 'q', 'b'],
    );
  });

  it('is NOT idempotent — re-running against a list that still holds the item duplicates it', () => {
    // Documents the contract: a double-rollback would insert a second copy. Each writer's
    // catch runs exactly once, so this is unreachable in prod — but the helper does not guard it.
    const once = reinsertBefore(rows('a', 'b', 'c'), { id: 'b' }, ['c']);
    expect(ids(once)).toEqual(['a', 'b', 'b', 'c']);
  });
});
