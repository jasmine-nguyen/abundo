// WHIT-273: the picker orders categories as a parent→child tree. These lock the pure ordering
// helper: depth-first (parent before its children), siblings A–Z, orphans/cross-bucket links
// surfaced as roots, and cycle-safety (no infinite loop, no dropped category).
import { it, expect, describe } from '@jest/globals';
import { categoryTreeRows, type Category } from '../context';

const cat = (id: string, name: string, parent: string | null = null, bucket: Category['bucket'] = 'Lifestyle'): Category =>
  ({ id, name, icon: 'tag', color: '#fff', bucket, recent: 0, parent });

const shape = (categories: Category[]) =>
  categoryTreeRows(categories).map((r) => ({ id: r.category.id, depth: r.depth, parentId: r.parentId, hasChildren: r.hasChildren }));

describe('categoryTreeRows', () => {
  it('emits each parent immediately before its children (depth-first), siblings A–Z', () => {
    // Supplied out of order; Food has Groceries + Dining, plus a top-level Transport.
    const categories = [
      cat('transport', 'Transport'),
      cat('groceries', 'Groceries', 'food'),
      cat('food', 'Food'),
      cat('dining', 'Dining', 'food'),
    ];
    expect(shape(categories)).toEqual([
      { id: 'food', depth: 0, parentId: null, hasChildren: true },
      { id: 'dining', depth: 1, parentId: 'food', hasChildren: false },
      { id: 'groceries', depth: 1, parentId: 'food', hasChildren: false },
      { id: 'transport', depth: 0, parentId: null, hasChildren: false },
    ]);
  });

  it('nests to arbitrary depth (parent > child > grandchild)', () => {
    const categories = [
      cat('a', 'A'),
      cat('b', 'B', 'a'),
      cat('c', 'C', 'b'),
    ];
    expect(shape(categories)).toEqual([
      { id: 'a', depth: 0, parentId: null, hasChildren: true },
      { id: 'b', depth: 1, parentId: 'a', hasChildren: true },
      { id: 'c', depth: 2, parentId: 'b', hasChildren: false },
    ]);
  });

  it('surfaces an orphan (parent id not in the set) as a top-level row', () => {
    const categories = [cat('a', 'A'), cat('orphan', 'Orphan', 'ghost')];
    expect(shape(categories)).toEqual([
      { id: 'a', depth: 0, parentId: null, hasChildren: false },
      { id: 'orphan', depth: 0, parentId: null, hasChildren: false },
    ]);
  });

  it('does not nest a child under a different-bucket parent — it becomes a root', () => {
    const categories = [
      cat('living', 'Living', null, 'Living'),
      cat('crossed', 'Crossed', 'living', 'Lifestyle'),
    ];
    expect(shape(categories)).toEqual([
      { id: 'crossed', depth: 0, parentId: null, hasChildren: false },
      { id: 'living', depth: 0, parentId: null, hasChildren: false },
    ]);
  });

  it('is cycle-safe: a corrupt A→B→A loop does not hang and drops no category', () => {
    const categories = [cat('a', 'A', 'b'), cat('b', 'B', 'a')];
    const rows = categoryTreeRows(categories);
    expect(rows.map((r) => r.category.id).sort()).toEqual(['a', 'b']);
  });

  it('returns an empty list for no categories', () => {
    expect(categoryTreeRows([])).toEqual([]);
  });
});
