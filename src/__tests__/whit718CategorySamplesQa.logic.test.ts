// WHIT-718 QA — the shared category samples: frozen, one home, and no copy hiding behind a
// different key order.
import { describe, it, expect, jest } from '@jest/globals';
import { COFFEE, COFFEE_RECORD, GROCERIES, SUBS, SALARY, SAVINGS } from './support/categories';
import * as budgetsTab from './support/budgetsTab';
import { findOffenders, q } from './support/sourceScan';

const HOME = 'support/categories.ts';
const SELF = 'whit718CategorySamplesQa.logic.test.ts';

// Every piece of each sample on one line, in any order, and not as cat() overrides.
const SAMPLE_PIECES = [
  [`id: ${q('coffee')}`, q('Cafes & Coffee'), q('#E8A87C'), 'recent: ' + '52'],
  [`id: ${q('groceries')}`, q('Groceries'), q('#7fd49b'), 'recent: ' + '100'],
  [`id: ${q('subs')}`, q('Subs'), q('#f0b27a'), 'recent: ' + '0'],
  [`id: ${q('salary')}`, q('Salary'), q('Income'), q('cash')],
  [`id: ${q('rainy')}`, q('Rainy Day'), q('Savings'), q('piggy-bank')],
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
      new Set([HOME, SELF, 'whit718CategorySamplesOneHome.logic.test.ts', 'whit721GroceriesRecordOneHome.logic.test.ts']),
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
