// eligibleChildren (WHIT-237): which existing categories may be attached AS CHILDREN of the
// category being edited — same bucket, never itself or one of its ancestors (cycle-safe), and
// within the 5-level depth cap. Pure, so it runs headlessly.
import { describe, it, expect } from '@jest/globals';
import { eligibleChildren, MAX_CATEGORY_DEPTH } from '../context';
import { cat } from './factory';

describe('eligibleChildren', () => {
  it('offers every same-bucket category for a NEW top-level parent', () => {
    const cats = [
      cat({ id: 'car', bucket: 'Living', parent: null }),
      cat({ id: 'groceries', bucket: 'Living', parent: null }),
      cat({ id: 'coffee', bucket: 'Lifestyle', parent: null }),   // different bucket
      cat({ id: 'salary', bucket: 'Income', parent: null }),      // different bucket
    ];
    const ids = eligibleChildren(cats, null, null, 'Living').map((c) => c.id).sort();
    expect(ids).toEqual(['car', 'groceries']);
  });

  it('excludes the category itself and its ancestors (cycle would form)', () => {
    // car <- parking <- petrol. Editing `parking` (parent car). Attaching car under parking
    // loops; parking-under-itself is self. petrol (current child) + groceries stay offered.
    const cats = [
      cat({ id: 'car', bucket: 'Living', parent: null }),
      cat({ id: 'parking', bucket: 'Living', parent: 'car' }),
      cat({ id: 'petrol', bucket: 'Living', parent: 'parking' }),
      cat({ id: 'groceries', bucket: 'Living', parent: null }),
    ];
    const ids = eligibleChildren(cats, 'parking', 'car', 'Living').map((c) => c.id).sort();
    expect(ids).toEqual(['groceries', 'petrol']);
  });

  it('excludes a candidate whose subtree would breach the 5-level cap', () => {
    // a<-b<-c<-d is 4 levels tall. Under a top-level parent (level 1): 1+4=5 OK. Under a
    // level-2 parent: 2+4=6 -> dropped. Fail-on-revert: without the depth check, `a` stays.
    const chain = [
      cat({ id: 'a', bucket: 'Living', parent: null }),
      cat({ id: 'b', bucket: 'Living', parent: 'a' }),
      cat({ id: 'c', bucket: 'Living', parent: 'b' }),
      cat({ id: 'd', bucket: 'Living', parent: 'c' }),
      cat({ id: 'top', bucket: 'Living', parent: null }),
      cat({ id: 'mid', bucket: 'Living', parent: 'top' }),        // mid sits at level 2
    ];
    expect(eligibleChildren(chain, null, null, 'Living').map((c) => c.id)).toContain('a');    // 1+4=5
    expect(eligibleChildren(chain, 'mid', 'top', 'Living').map((c) => c.id)).not.toContain('a'); // 2+4=6
    expect(MAX_CATEGORY_DEPTH).toBe(5);
  });

  it('does not hang on a corrupt parent cycle', () => {
    const cyclic = [
      cat({ id: 'a', bucket: 'Living', parent: 'b' }),
      cat({ id: 'b', bucket: 'Living', parent: 'a' }),           // a<->b
      cat({ id: 'c', bucket: 'Living', parent: null }),
    ];
    const ids = eligibleChildren(cyclic, 'a', 'b', 'Living').map((x) => x.id);
    expect(ids).toEqual(['c']); // a=self, b=ancestor-of-self, both excluded; must not loop
  });
});
