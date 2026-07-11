// WHIT-237 — [A11] categoryDepth: the level a category sits at given its parent id (top-level
// = 1). Extracted from a duplicated inline walk so the edit screen's "New sub-category" depth
// gate and eligibleChildren can't drift. Pure, runs headlessly. Gap: the implementer's suite
// exercises eligibleChildren but never categoryDepth directly.
import { describe, it, expect } from '@jest/globals';
import { categoryDepth, MAX_CATEGORY_DEPTH } from '../context';
import { cat } from './factory';

describe('categoryDepth', () => {
  it('a null parent is top-level → level 1', () => {
    expect(categoryDepth([], null)).toBe(1);
  });

  it('a child of a top-level parent sits at level 2', () => {
    const cats = [cat({ id: 'car', parent: null })];
    // parent 'car' is level 1, so THIS category (its child) is level 2.
    expect(categoryDepth(cats, 'car')).toBe(2);
  });

  it('a level-4 parent puts its child at the 5-level cap boundary', () => {
    // a(1) <- b(2) <- c(3) <- d(4). A new child under d would be level 5 = the cap.
    const chain = [
      cat({ id: 'a', parent: null }),
      cat({ id: 'b', parent: 'a' }),
      cat({ id: 'c', parent: 'b' }),
      cat({ id: 'd', parent: 'c' }),
    ];
    expect(categoryDepth(chain, 'd')).toBe(5);
    // This is exactly the value the edit screen compares against to hide the button:
    // canAddNewChild = categoryDepth(...) < MAX_CATEGORY_DEPTH → 5 < 5 is false → hidden.
    expect(categoryDepth(chain, 'd') < MAX_CATEGORY_DEPTH).toBe(false);
    // One shallower (level-3 parent 'c') → child level 4 → still under the cap → button shown.
    expect(categoryDepth(chain, 'c') < MAX_CATEGORY_DEPTH).toBe(true);
  });

  it('does not hang on a corrupt parent cycle', () => {
    const cyclic = [cat({ id: 'a', parent: 'b' }), cat({ id: 'b', parent: 'a' })];
    // a<->b: the walk must terminate (seen-set), not spin. Value is bounded, not asserted exact.
    expect(categoryDepth(cyclic, 'a')).toBeGreaterThan(0);
  });
});
