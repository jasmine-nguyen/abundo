// eligibleParents (WHIT-221): which categories may be a category's parent in the
// category-edit picker — same bucket, never itself, never one of its own descendants
// (cycle-safe). Pure, so it runs headlessly.
import { describe, it, expect } from '@jest/globals';
import { eligibleParents } from '../context';
import { cat } from './factory';

const CATS = [
  cat({ id: 'car', bucket: 'Living', parent: null }),
  cat({ id: 'parking', bucket: 'Living', parent: 'car' }),      // child of car
  cat({ id: 'petrol', bucket: 'Living', parent: 'parking' }),   // grandchild of car
  cat({ id: 'groceries', bucket: 'Living', parent: null }),
  cat({ id: 'coffee', bucket: 'Lifestyle', parent: null }),     // different bucket
  cat({ id: 'salary', bucket: 'Income', parent: null }),
];

describe('eligibleParents', () => {
  it('for a NEW category, offers every same-bucket category', () => {
    const ids = eligibleParents(CATS, null, 'Living').map((c) => c.id);
    expect(ids.sort()).toEqual(['car', 'groceries', 'parking', 'petrol']);
    // never a different bucket
    expect(ids).not.toContain('coffee');
    expect(ids).not.toContain('salary');
  });

  it('excludes the category itself and ALL its descendants (cycle-safe)', () => {
    // Editing "car": car itself, parking (child) and petrol (grandchild) are ineligible;
    // only the unrelated same-bucket "groceries" remains.
    const ids = eligibleParents(CATS, 'car', 'Living').map((c) => c.id);
    expect(ids).toEqual(['groceries']);
  });

  it('filters by the passed (in-form) bucket, not the stored one', () => {
    // Editing "coffee" but the form bucket is now Living → only Living options, coffee
    // excluded (self), and its old Lifestyle peers gone.
    const ids = eligibleParents(CATS, 'coffee', 'Living').map((c) => c.id).sort();
    expect(ids).toEqual(['car', 'groceries', 'parking', 'petrol']);
  });

  it('does not hang on a corrupt parent cycle', () => {
    const cyclic = [
      cat({ id: 'a', bucket: 'Living', parent: 'b' }),
      cat({ id: 'b', bucket: 'Living', parent: 'a' }),
      cat({ id: 'c', bucket: 'Living', parent: null }),
    ];
    // Must return (not loop). Editing 'a': 'b' descends from 'a' so it's excluded; 'c' is free.
    const ids = eligibleParents(cyclic, 'a', 'Living').map((x) => x.id);
    expect(ids).toEqual(['c']);
  });
});
