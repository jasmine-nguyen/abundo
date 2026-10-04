// WHIT-719 slice 3 QA — the delete-category setup has one home across the whole test tree, the
// order-free matcher tells the new samples from their lookalikes, the samples can't be changed, and
// the shared charge helpers build what both delete tests expect.
import { describe, it, expect } from '@jest/globals';
import { COFFEE_SHORT, DINING, ESSENTIAL_GROCERIES, ESSENTIAL_GROCERIES_TOP } from './support/categories';
import { DELETE_DINING, tx, page } from './support/deleteCategorySeed';
import { findOffenders } from './support/sourceScan';
import { isCopyOf } from './support/inlineRecords';
import { CATEGORIES_HOME, quoted as q } from './support/oneHomeGuard';

const SELF = 'whit719RemainingPairsQa.logic.test.ts';
const ALLOWED = new Set([CATEGORIES_HOME, 'support/deleteCategorySeed.ts', 'whit719RemainingPairsOneHome.logic.test.ts', SELF]);

describe('WHIT-719 QA: the delete-category setup has one home in the whole test tree', () => {
  // [A1] the slice guard only reads the two delete tests; another file copying the setup must fail too.
  // (Its Groceries alone also matches a one-off server reply in appProvider, so the Dining half marks the setup.)
  it('[A1] no test file spells out the delete-category Dining, in any key order', () => {
    expect(findOffenders(isCopyOf(DELETE_DINING), ALLOWED)).toEqual([]);
  });
});

describe('WHIT-719 QA: the matcher tells the new samples from their lookalikes', () => {
  // [A2] a reordered copy is caught; a near miss (other name, extra key, other bucket) is not
  it('[A2] reordered copies match, near misses do not', () => {
    const coffee = isCopyOf(COFFEE_SHORT);
    expect(coffee(`{ bucket: ${q('Lifestyle')}, icon: ${q('coffee')}, name: ${q('Coffee')}, id: ${q('coffee')} }`)).toBe(true);
    expect(coffee(`{ id: ${q('coffee')}, name: ${q('Coffee')}, icon: ${q('coffee')}, bucket: ${q('Lifestyle')}, parent: null }`)).toBe(false);
    expect(coffee(`{ id: ${q('coffee')}, name: ${q('Cafes & Coffee')}, icon: ${q('coffee')}, bucket: ${q('Lifestyle')} }`)).toBe(false);

    const dining = isCopyOf(DINING);
    expect(dining(`{ recent: 0, color: ${q('#f7768e')}, icon: ${q('utensils')}, bucket: ${q('Lifestyle')}, name: ${q('Dining')}, id: ${q('dining')} }`)).toBe(true);
    expect(dining(`{ id: ${q('dining')}, name: ${q('Dining')}, bucket: ${q('Living')}, icon: ${q('food')}, color: ${q('#f00')}, recent: 0, parent: null }`)).toBe(false);

    const essentials = isCopyOf(ESSENTIAL_GROCERIES);
    expect(essentials(`{ id: ${q('groceries')}, name: ${q('Groceries')}, bucket: ${q('Essentials')}, icon: ${q('cart')}, color: ${q('#00AA00')} }`)).toBe(true);
    expect(essentials(`{ id: ${q('groceries')}, name: ${q('Groceries')}, bucket: ${q('Living')}, icon: ${q('cart')}, color: ${q('#00AA00')} }`)).toBe(false);

    const essentialsTop = isCopyOf(ESSENTIAL_GROCERIES_TOP);
    expect(essentialsTop(`{ parent: null, recent: 0, bucket: ${q('Essentials')}, icon: ${q('cart')}, name: ${q('Groceries')}, id: ${q('groceries')} }`)).toBe(true);
    expect(essentialsTop(`{ id: ${q('groceries')}, name: ${q('Groceries')}, icon: ${q('cart')}, bucket: ${q('Essentials')}, parent: null }`)).toBe(false);
  });
});

describe('WHIT-719 QA: the new shared samples cannot be changed by a test', () => {
  // [A3] a write to a shared sample is refused or ignored
  it('[A3] writing to a new shared sample leaves it unchanged', () => {
    try { (DINING as { recent: number }).recent = 99; } catch { /* strict mode refuses the write */ }
    try { (COFFEE_SHORT as { name: string }).name = 'Changed'; } catch { /* same */ }
    try { (ESSENTIAL_GROCERIES as { color: string }).color = '#000'; } catch { /* same */ }
    try { (ESSENTIAL_GROCERIES_TOP as { parent: string | null }).parent = 'food'; } catch { /* same */ }
    expect(DINING.recent).toBe(0);
    expect(COFFEE_SHORT.name).toBe('Coffee');
    expect(ESSENTIAL_GROCERIES.color).toBe('#00AA00');
    expect(ESSENTIAL_GROCERIES_TOP.parent).toBeNull();
  });
});

describe('WHIT-719 QA: the shared delete-category charge helpers', () => {
  // [A4] tx() builds a posted Dining charge, and an override wins (t3 is seeded uncategorised)
  it('[A4] tx() defaults to a posted $12.50 Dining charge and takes overrides', () => {
    expect(tx('t1')).toEqual({
      transaction_id: 't1', date: '2026-07-01', authorized_date: '2026-07-01',
      description: 'COLES 0412 SYDNEY', merchant_name: 'Coles', amount: -12.5, account_id: 'a1',
      account_name: 'ANZ', category: 'dining', status: 'posted', type: 'PAYMENT', counts_to_budget: true,
    });
    expect(tx('t3', { category: null })).toMatchObject({ transaction_id: 't3', category: null });
  });

  // [A5] page() wraps charges into a single, last feed page
  it('[A5] page() wraps the charges into one last page', () => {
    const charges = [tx('t1'), tx('t2', { category: 'groceries' })];
    expect(page(charges)).toEqual({ pages: [{ transactions: charges, nextCursor: null }], pageParams: [undefined] });
  });
});
