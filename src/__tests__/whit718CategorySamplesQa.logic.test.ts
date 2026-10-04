// WHIT-718 QA — the shared category samples: frozen, one home, and no copy hiding behind a
// different key order.
import { describe, it, expect, jest } from '@jest/globals';
import { COFFEE, COFFEE_RECORD, GROCERIES, SUBS, SALARY, SAVINGS } from './support/categories';
import * as budgetsTab from './support/budgetsTab';
import { findOffenders } from './support/sourceScan';
import { CATEGORIES_HOME, quoted } from './support/oneHomeGuard';

const SELF = 'whit718CategorySamplesQa.logic.test.ts';

// Every piece of each sample on one line, in any order, and not as cat() overrides.
const SAMPLE_PIECES = [
  [`id: ${quoted('coffee')}`, quoted('Cafes & Coffee'), quoted('#E8A87C'), 'recent: ' + '52'],
  [`id: ${quoted('groceries')}`, quoted('Groceries'), quoted('#7fd49b'), 'recent: ' + '100'],
  [`id: ${quoted('subs')}`, quoted('Subs'), quoted('#f0b27a'), 'recent: ' + '0'],
  [`id: ${quoted('salary')}`, quoted('Salary'), quoted('Income'), quoted('cash')],
  [`id: ${quoted('rainy')}`, quoted('Rainy Day'), quoted('Savings'), quoted('piggy-bank')],
];

describe('WHIT-718 QA: shared category samples', () => {
  // [A1]
  it('every shared sample is frozen, so one test cannot change it for the next', () => {
    for (const sample of [COFFEE_RECORD, COFFEE, GROCERIES, SUBS, SALARY, SAVINGS]) {
      expect(Object.isFrozen(sample)).toBe(true);
    }
  });

  // [A2]
  it('no test file re-spells a sample with its keys in a different order', () => {
    const offenders = findOffenders(
      (line) => !line.includes('cat(') && SAMPLE_PIECES.some((pieces) => pieces.every((piece) => line.includes(piece))),
      new Set([CATEGORIES_HOME, SELF, 'whit718CategorySamplesOneHome.logic.test.ts']),
    );
    expect(offenders).toEqual([]);
  });

  // [A3]
  it('budgetsTab no longer exports its own COFFEE: categories.ts is the one home', () => {
    expect(Object.keys(budgetsTab)).not.toContain('COFFEE');
  });

  // [A4]
  it('seedBudgetsTab still seeds the shared coffee category by default', () => {
    const seed = jest.fn();
    budgetsTab.seedBudgetsTab({ seed } as never, {});
    expect(seed).toHaveBeenCalledWith('/categories', [COFFEE]);
  });
});
