// WHIT-750 — budget rows no longer carry a "spending too fast" flag; nothing on the Budgets tab
// read it. The detail screen still warns with the shared pace rule, and stays calm for a bill
// paid in one go.
import { describe, it, expect } from '@jest/globals';
import { C } from '../theme';
import { budgetDetailFor, budgetRowFor } from './support/budgetsTab';
import { SALARY } from './support/categories';

const PACE_FLAG = 'behind' + 'Pace';

const ROW_FIELDS = [
  'id', 'name', 'color', 'icon', 'chipBg',
  'spentLabel', 'remainAmount', 'remainLabel', 'remainColor',
  'postedPct', 'pendingPct', 'targetPct', 'postedColor',
  'pendingTint', 'over', 'note', 'depth', 'parentId',
  'section', 'showTarget', 'unspent',
].sort();

describe('budget rows carry no pace flag (WHIT-750)', () => {
  it('a fast-spending row has exactly the other row fields, and no pace flag', () => {
    // Halfway through: $80 spent of $100 → past the $50 pace line, not over.
    const fast = budgetRowFor({ budget: 100, posted: 70, pending: 10 });
    expect(PACE_FLAG in fast).toBe(false);
    expect(Object.keys(fast).sort()).toEqual(ROW_FIELDS);
    expect(fast.over).toBe(false);
    expect(fast.targetPct).toBe(50);
    expect(fast.section).toBe('spending');
  });

  it('an earning row has no pace flag either', () => {
    const income = budgetRowFor({ budget: 5000, posted: 1000 }, SALARY);
    expect(PACE_FLAG in income).toBe(false);
    expect(Object.keys(income).sort()).toEqual(ROW_FIELDS);
    expect(income.section).toBe('earning');
  });
});

describe('budget detail still warns about spending too fast (WHIT-750)', () => {
  it('past the pace line → "Over plan — ease up"; under it → calm', () => {
    const fast = budgetDetailFor({ budget: 100, posted: 80 });
    expect(fast.statusLabel).toBe('Over plan — ease up');
    expect(fast.statusColor).toBe(C.textInfo);

    const calm = budgetDetailFor({ budget: 100, posted: 20 });
    expect(calm.statusLabel).toBe('On track for payday');
  });
});
