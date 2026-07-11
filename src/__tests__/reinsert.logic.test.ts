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
