// WHIT-840: the stored budget always carries the server's 'available to spend'. When the server
// leaves it out (past-cycle export rows only) the budget gets its plain target — the app never
// adds up target + carryover + spread itself.
import { describe, it, expect } from '@jest/globals';
import type { BudgetRollup } from '../api';
import { availableToSpend } from '../budgetMath';
import { toBudget } from '../model';

const row = (over: Partial<BudgetRollup>): BudgetRollup => ({ target: 400, posted: 50, pending: 10, ...over });

describe('toBudget — available to spend', () => {
  it.each<[string, BudgetRollup, number]>([
    ['server figure passes through', row({ available: 525, rollover: true, carryover: 125 }), 525],
    ['a server 0 is kept', row({ available: 0 }), 0],
    ['missing → target, plain budget', row({}), 400],
    ['missing → target, even with rollover carryover', row({ rollover: true, carryover: 120 }), 400],
    ['missing → target, even with a negative carryover', row({ rollover: true, carryover: -150 }), 400],
    ['missing → target, even with a spread slice', row({ spread: { amount: 180, cycles: 3, index: 0, adjustment: 60 } }), 400],
  ])('%s', (_name, rollup, expected) => {
    const stored = toBudget('coffee', rollup);
    expect(stored.available).toBe(expected);
    expect(availableToSpend(stored)).toBe(expected);
  });
});
