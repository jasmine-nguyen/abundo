// WHIT-254 — adversarial edge coverage for the pure reinsert helper, beyond the
// implementer's reinsert.logic.test.ts (which covers single reinsert + 2-delete
// interleavings). Here: THREE concurrent rollbacks in EVERY resolution order, a
// successorIds list padded with ids that aren't in the list, a duplicate-id list,
// and the double-rollback (item already present) idempotency question.
import { describe, it, expect } from '@jest/globals';
import { reinsertBefore } from '../reinsert';

type Row = { id: string };
const rows = (...ids: string[]): Row[] => ids.map((id) => ({ id }));
const ids = (list: Row[]) => list.map((x) => x.id);

// every ordering of an array of unary list->list transforms
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
