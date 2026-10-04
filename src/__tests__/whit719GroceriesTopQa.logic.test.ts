// WHIT-719 slice 1 QA — the groceries row has one home whatever order its keys are written in, and
// no test can change the shared samples.
import { describe, it, expect } from '@jest/globals';
import { GROCERIES_TOP, GROCERIES_TOP_RECORD } from './support/categories';
import { findOffenders } from './support/sourceScan';
import { isCopyOf } from './support/inlineRecords';
import { CATEGORIES_HOME, quoted } from './support/oneHomeGuard';

const SELF = 'whit719GroceriesTopQa.logic.test.ts';
const ALLOWED = new Set([CATEGORIES_HOME, 'whit719GroceriesTopOneHome.logic.test.ts', SELF]);

describe('WHIT-719 QA: the groceries row has one home, in any key order', () => {
  // [A1] the colourless twin written in the home's own key order (bucket before icon) is still a copy
  it('[A1] no test file spells out GROCERIES_TOP_RECORD, whatever the key order', () => {
    expect(findOffenders(isCopyOf(GROCERIES_TOP_RECORD), ALLOWED)).toEqual([]);
  });

  // [A2] the coloured row in any key order is a copy too
  it('[A2] no test file spells out GROCERIES_TOP, whatever the key order', () => {
    expect(findOffenders(isCopyOf(GROCERIES_TOP), ALLOWED)).toEqual([]);
  });

  // [A3] the matcher itself: a reordered copy matches, a near-miss (extra key or other value) does not
  it('[A3] the order-free matcher catches a reordered copy and skips near misses', () => {
    const isCopy = isCopyOf(GROCERIES_TOP_RECORD);
    expect(isCopy(`const X = { parent: null, icon: ${quoted('cart')}, bucket: ${quoted('Living')}, name: ${quoted('Groceries')}, id: ${quoted('groceries')} };`)).toBe(true);
    expect(isCopy(`{ id: ${quoted('groceries')}, name: ${quoted('Groceries')}, bucket: ${quoted('Living')}, icon: ${quoted('cart')}, parent: null, recent: 0 }`)).toBe(false);
    expect(isCopy(`{ id: ${quoted('groceries')}, name: ${quoted('Groceries')}, bucket: ${quoted('Essentials')}, icon: ${quoted('cart')}, parent: null }`)).toBe(false);
  });
});

describe('WHIT-719 QA: the shared groceries samples cannot be changed by a test', () => {
  // [A4] a test that tries to change the shared sample directly can't (the write is refused or ignored)
  it('[A4] writing to a shared groceries sample leaves it unchanged', () => {
    try { (GROCERIES_TOP as { color: string }).color = '#000'; } catch { /* strict mode refuses the write */ }
    try { (GROCERIES_TOP_RECORD as { parent: string | null }).parent = 'food'; } catch { /* same */ }
    expect(GROCERIES_TOP.color).toBe('#7FD49B');
    expect(GROCERIES_TOP_RECORD.parent).toBeNull();
  });
});
