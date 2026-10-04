// WHIT-719 slice 2 fix-round QA — the plain groceries record the add-rule lists now share, and the
// shared copy-detection helper the guards lean on.
import { describe, it, expect } from '@jest/globals';
import { GROCERIES, GROCERIES_RECORD, GROCERIES_TOP_RECORD } from './support/categories';
import { isCopyOf } from './support/inlineRecords';

describe('WHIT-719 QA: the plain groceries record', () => {
  // [A9] the record keeps the exact values the 8 inline copies had
  it('[A9] GROCERIES_RECORD is the plain Living groceries row and is frozen', () => {
    expect(GROCERIES_RECORD).toEqual({ id: 'groceries', name: 'Groceries', icon: 'cart', bucket: 'Living' });
    expect(Object.isFrozen(GROCERIES_RECORD)).toBe(true);
  });

  // [A10] the samples built on top of it keep their values (no drift from the refactor)
  it('[A10] GROCERIES and GROCERIES_TOP_RECORD are GROCERIES_RECORD plus only their own extras', () => {
    const { color, recent, ...groceriesRest } = GROCERIES;
    expect(groceriesRest).toEqual(GROCERIES_RECORD);
    expect({ color, recent }).toEqual({ color: '#7fd49b', recent: 100 });
    const { parent, ...topRest } = GROCERIES_TOP_RECORD;
    expect(topRest).toEqual(GROCERIES_RECORD);
    expect(parent).toBeNull();
  });
});

describe('WHIT-719 QA: isCopyOf spots a copy in any key order, and only an exact copy', () => {
  const sample = { id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart' };

  // [A11] key order doesn't hide a copy
  it('[A11] matches a reordered one-line copy', () => {
    expect(isCopyOf(sample)("  { icon: 'cart', bucket: 'Living', name: 'Groceries', id: 'groceries' },")).toBe(true);
  });

  // [A12] an extra or changed key is a different sample, not a copy
  it('[A12] ignores a literal with an extra key or a different value', () => {
    expect(isCopyOf(sample)("{ id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', recent: 0 }")).toBe(false);
    expect(isCopyOf(sample)("{ id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'basket' }")).toBe(false);
  });

  // [A13] null and number values are read as values, not strings
  it('[A13] reads null and numbers so a parent: null / recent: 0 copy matches', () => {
    expect(isCopyOf({ ...sample, parent: null, recent: 0 })("{ id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', parent: 'food', recent: 0 }")).toBe(false);
    expect(isCopyOf({ ...sample, parent: null, recent: 0 })("[{ id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', parent: null, recent: 0 }]")).toBe(true);
  });
});
