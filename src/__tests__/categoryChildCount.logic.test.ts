// WHIT-441 item 1 — childCount(categories, parentId): the client mirror of the server's per-parent
// sub-category tally that the picker uses to grey a full parent. Pure exported selector, so this is
// the fast regression gate for the boundary (49 vs 50) and the cycle/edge inputs the screen tests
// can't cheaply reach. Asserts against the REAL export in ../context — no re-implementation.
import { describe, it, expect } from '@jest/globals';
import { childCount, MAX_CHILDREN_PER_CATEGORY } from '../context';
import { cat } from './factory';

const kids = (parent: string, n: number) =>
  Array.from({ length: n }, (_, i) => cat({ id: `${parent}-k${i}`, parent }));

describe('childCount', () => {
  it('counts only the DIRECT children of the given parent', () => {
    const cats = [
      cat({ id: 'p', parent: null }),
      ...kids('p', 3),
      cat({ id: 'q', parent: null }),
      ...kids('q', 5),
      cat({ id: 'gc', parent: 'p-k0' }),   // a grandchild must NOT count toward p
    ];
    expect(childCount(cats, 'p')).toBe(3);
    expect(childCount(cats, 'q')).toBe(5);
  });

  it('is 0 for a parent id that appears in no .parent field, and for an empty list', () => {
    expect(childCount([cat({ id: 'p', parent: null })], 'nope')).toBe(0);
    expect(childCount([], 'p')).toBe(0);
  });

  // The boundary the picker/toast hinge on: 49 is NOT at the cap, exactly 50 IS.
  it('reports 49 below the cap and exactly 50 at it', () => {
    const at49 = [cat({ id: 'p', parent: null }), ...kids('p', MAX_CHILDREN_PER_CATEGORY - 1)];
    const at50 = [cat({ id: 'p', parent: null }), ...kids('p', MAX_CHILDREN_PER_CATEGORY)];
    expect(childCount(at49, 'p')).toBe(49);
    expect(childCount(at49, 'p') >= MAX_CHILDREN_PER_CATEGORY).toBe(false);   // picker: NOT full
    expect(childCount(at50, 'p')).toBe(50);
    expect(childCount(at50, 'p') >= MAX_CHILDREN_PER_CATEGORY).toBe(true);    // picker: full
  });

  // Cycle-safe by construction: it is a flat count over .parent, so a self-parent or a 2-node
  // cycle can't loop it, and a self-parent legitimately counts itself as its own child.
  it('does not loop on a self-parent or a parent/child cycle', () => {
    const selfLoop = [cat({ id: 'p', parent: 'p' })];
    expect(childCount(selfLoop, 'p')).toBe(1);
    const twoCycle = [cat({ id: 'a', parent: 'b' }), cat({ id: 'b', parent: 'a' })];
    expect(childCount(twoCycle, 'a')).toBe(1);   // only b points at a
    expect(childCount(twoCycle, 'b')).toBe(1);
  });
});
