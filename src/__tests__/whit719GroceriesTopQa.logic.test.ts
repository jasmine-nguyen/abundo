// WHIT-719 slice 1 QA — the groceries row has one home whatever order its keys are written in, and
// no test can change the shared samples.
import { describe, it, expect } from '@jest/globals';
import { GROCERIES_TOP, GROCERIES_TOP_RECORD } from './support/categories';
import { findOffenders } from './support/sourceScan';

const SELF = 'whit719GroceriesTopQa.logic.test.ts';
const ALLOWED = new Set(['support/categories.ts', 'whit719GroceriesTopOneHome.logic.test.ts', SELF]);

// Every one-line `{ key: value, ... }` on the line, read as a plain object (string, number or null values only).
function inlineObjects(line: string): Record<string, unknown>[] {
  return (line.match(/\{[^{}]*\}/g) ?? []).map((literal) => {
    const record: Record<string, unknown> = {};
    for (const [, key, value] of literal.matchAll(/(\w+): ('[^']*'|null|-?\d+)/g)) {
      if (value === 'null') record[key] = null;
      else if (value.startsWith("'")) record[key] = value.slice(1, -1);
      else record[key] = Number(value);
    }
    return record;
  });
}

const sameRecord = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(b).every(([key, value]) => a[key] === value);

const isCopyOf = (sample: Record<string, unknown>) => (line: string) =>
  inlineObjects(line).some((record) => sameRecord(record, sample));

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
    const q = (text: string) => `'${text}'`;
    const isCopy = isCopyOf(GROCERIES_TOP_RECORD);
    expect(isCopy(`const X = { parent: null, icon: ${q('cart')}, bucket: ${q('Living')}, name: ${q('Groceries')}, id: ${q('groceries')} };`)).toBe(true);
    expect(isCopy(`{ id: ${q('groceries')}, name: ${q('Groceries')}, bucket: ${q('Living')}, icon: ${q('cart')}, parent: null, recent: 0 }`)).toBe(false);
    expect(isCopy(`{ id: ${q('groceries')}, name: ${q('Groceries')}, bucket: ${q('Essentials')}, icon: ${q('cart')}, parent: null }`)).toBe(false);
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
