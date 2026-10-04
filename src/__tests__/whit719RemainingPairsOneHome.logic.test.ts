// WHIT-719 slice 3 — the remaining paired category samples live once: the short coffee (tab bar dot),
// the 'Essentials' groceries (shared-wait and fake-server tests), dining, and the delete-category setup.
// The budget-edit test keeps one income sample and spreads it where it differs.
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from '@jest/globals';
import {
  COFFEE_SHORT,
  DINING,
  ESSENTIAL_GROCERIES,
  ESSENTIAL_GROCERIES_RECORD,
  ESSENTIAL_GROCERIES_TOP,
} from './support/categories';
import {
  DELETE_DINING,
  DELETE_DINING_BUDGET,
  DELETE_DINING_RULE,
  DELETE_GROCERIES,
  DELETE_GROCERIES_BUDGET,
  DELETE_GROCERIES_RULE,
} from './support/deleteCategorySeed';
import { findOffenders } from './support/sourceScan';
import { isCopyOf } from './support/inlineRecords';
import { CATEGORIES_HOME } from './support/oneHomeGuard';

const SELF = 'whit719RemainingPairsOneHome.logic.test.ts';
const DELETE_SEED_HOME = 'support/deleteCategorySeed.ts';
const ALLOWED = new Set([CATEGORIES_HOME, DELETE_SEED_HOME, SELF]);
const DELETE_FILES = ['deleteCategoryOptimistic.provider.screen.test.tsx', 'deleteCategoryOptimisticQa.provider.screen.test.tsx'];

const offendersOf = (sample: Record<string, unknown>) => findOffenders(isCopyOf(sample), ALLOWED);
const linesOf = (file: string) => readFileSync(join(__dirname, file), 'utf8').split('\n');

describe('the remaining paired category samples have one home', () => {
  it('support/categories exports the short coffee, the Essentials groceries and dining, frozen', () => {
    expect(COFFEE_SHORT).toEqual({ id: 'coffee', name: 'Coffee', icon: 'coffee', bucket: 'Lifestyle' });
    expect(ESSENTIAL_GROCERIES_RECORD).toEqual({ id: 'groceries', name: 'Groceries', icon: 'cart', bucket: 'Essentials' });
    expect(ESSENTIAL_GROCERIES).toEqual({ id: 'groceries', name: 'Groceries', icon: 'cart', bucket: 'Essentials', color: '#00AA00' });
    expect(ESSENTIAL_GROCERIES_TOP).toEqual({ id: 'groceries', name: 'Groceries', icon: 'cart', bucket: 'Essentials', recent: 0, parent: null });
    expect(DINING).toEqual({ id: 'dining', name: 'Dining', bucket: 'Lifestyle', icon: 'utensils', color: '#f7768e', recent: 0 });
    for (const sample of [COFFEE_SHORT, ESSENTIAL_GROCERIES_RECORD, ESSENTIAL_GROCERIES, ESSENTIAL_GROCERIES_TOP, DINING]) {
      expect(Object.isFrozen(sample)).toBe(true);
    }
  });

  it('support/deleteCategorySeed exports the delete-category setup with its values unchanged', () => {
    expect(DELETE_DINING).toEqual({ id: 'dining', name: 'Dining', bucket: 'Living', icon: 'food', color: '#f00', recent: 0, parent: null });
    expect(DELETE_GROCERIES).toEqual({ id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#0f0', recent: 0, parent: null });
    expect(DELETE_DINING_RULE).toEqual({ id: 'r1', pattern: 'COLES', categoryId: 'dining', isNew: false });
    expect(DELETE_GROCERIES_RULE).toEqual({ id: 'r2', pattern: 'WOOLIES', categoryId: 'groceries', isNew: false });
    expect(DELETE_DINING_BUDGET).toEqual({ target: 200, posted: 12.5, pending: 0 });
    expect(DELETE_GROCERIES_BUDGET).toEqual({ target: 300, posted: 0, pending: 0 });
  });

  it('no other test file spells out the short coffee, the Essentials groceries or dining, in any key order', () => {
    expect(offendersOf(COFFEE_SHORT)).toEqual([]);
    expect(offendersOf(ESSENTIAL_GROCERIES)).toEqual([]);
    expect(offendersOf(ESSENTIAL_GROCERIES_TOP)).toEqual([]);
    expect(offendersOf(DINING)).toEqual([]);
  });

  it('the two delete-category tests import the setup instead of spelling it out', () => {
    // The order-free matcher reads only string, whole-number and null values, so the rules (isNew: false)
    // and the 12.5 budget are matched by their text instead.
    const records = [DELETE_DINING, DELETE_GROCERIES, DELETE_GROCERIES_BUDGET];
    const texts = [`pattern: 'COLES', categoryId: 'dining'`, `pattern: 'WOOLIES', categoryId: 'groceries'`, 'target: 200, posted: 12.5'];
    const isSeedCopy = (line: string) => records.some((sample) => isCopyOf(sample)(line)) || texts.some((text) => line.includes(text));
    const copies = DELETE_FILES.flatMap((file) =>
      linesOf(file).flatMap((line, index) => (isSeedCopy(line) ? [`${file}:${index + 1}`] : [])),
    );
    expect(copies).toEqual([]);
    for (const file of DELETE_FILES) expect(linesOf(file).some((line) => line.includes('support/deleteCategorySeed'))).toBe(true);
  });

  it('the budget-edit test spells out its income sample once and spreads it where it differs', () => {
    const income = { id: 'salary', name: 'Salary', icon: 'briefcase', color: '#7fd49b', bucket: 'Income' };
    const isIncome = (line: string) => isCopyOf({ ...income, recent: 0 })(line) || isCopyOf({ ...income, recent: 4000 })(line);
    expect(linesOf('budgetEditSave.screen.test.tsx').filter(isIncome)).toHaveLength(1);
  });
});
