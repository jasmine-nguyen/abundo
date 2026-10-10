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
  it.each([
    { name: 'inserts before the first surviving successor (a middle row)', list: ['a', 'c', 'd'], item: 'b', successors: ['c', 'd'], expected: ['a', 'b', 'c', 'd'] },
    { name: 'inserts at the front (a first row)', list: ['b', 'c'], item: 'a', successors: ['b', 'c'], expected: ['a', 'b', 'c'] },
    { name: 'appends when there is no successor (a last row)', list: ['a', 'b'], item: 'c', successors: [], expected: ['a', 'b', 'c'] },
    { name: 'appends when every successor was also deleted', list: ['b'], item: 'a', successors: ['c'], expected: ['b', 'a'] },
    { name: 'appends into an empty list (only element)', list: [], item: 'a', successors: [], expected: ['a'] },
    { name: 'appends into an empty list (all successors gone)', list: [], item: 'a', successors: ['z'], expected: ['a'] },
  ])('$name', ({ list, item, successors, expected }) => {
    expect(ids(reinsertBefore(rows(...list), { id: item }, successors))).toEqual(expected);
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
// concurrent rollbacks in EVERY resolution order, and a successorIds list padded with absent ids.
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
});

describe('reinsertBefore — malformed / defensive inputs', () => {
  it('skips successor ids that are absent and anchors on the first present one', () => {
    // successorIds carries stale/never-present ids ('x','y') around the real 'c'.
    expect(ids(reinsertBefore(rows('a', 'c', 'd'), { id: 'b' }, ['x', 'c', 'y']))).toEqual(
      ['a', 'b', 'c', 'd'],
    );
  });
});
