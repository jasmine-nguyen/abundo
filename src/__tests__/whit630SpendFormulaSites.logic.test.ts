// WHIT-630 QA: budgetViews and budgetDetail both read the server's `available`
// and the pace through paceTarget — so each screen honours a server `available`
// (including a server 0) and keeps pace on the BASE target, not the envelope.
import { describe, it, expect } from '@jest/globals';
import { budgetViews, budgetDetail } from '../context';
import { makeState, cat, budget } from './factory';

const food = cat({ id: 'food', name: 'Food', bucket: 'Living' });
const state = (b: object) => makeState({
  categories: [food],
  budgets: [budget({ id: 'food', ...b })],
  cycleLen: 14, daysLeft: 7,
});

describe('a server `available` wins at every read site', () => {
  // parts-sum would be 100 + 200 = 300; the server says 250.
  const serverValue = { budget: 100, posted: 0, pending: 0, rollover: true, carryover: 200, available: 250 };

  it('[A2] (P0) budgetViews totals use the server spendable', () => {
    expect(budgetViews(state(serverValue)).totBudget).toBe(250);
  });

  it('[A3] (P0) budgetDetail "of" line uses the server spendable', () => {
    const detail = budgetDetail(state(serverValue), 'food');
    expect(detail?.ofBudget).toContain('250');
    expect(detail?.ofBudget).not.toContain('300');
  });
});

describe('a server 0 is kept, not replaced by the parts-sum', () => {
  const drained = { budget: 400, posted: 10, pending: 0, available: 0 };

  it('[A1] (P0) budgetViews reads the row as over budget', () => {
    const view = budgetViews(state(drained));
    expect(view.rows[0].over).toBe(true);
    expect(view.totBudget).toBe(0);
  });

  it('[A1] (P0) budgetDetail reads over against the server 0', () => {
    const detail = budgetDetail(state(drained), 'food');
    expect(detail?.ofBudget).toContain('$0');
    expect(detail?.statusLabel).toBe('Over budget — ease up');
  });
});

describe('the two sites agree with the budget\'s available', () => {
  const cases = [
    { budget: 100, posted: 30, pending: 5, rollover: true, carryover: 50 },
    { budget: 100, posted: 30, pending: 5, rollover: false, carryover: 50 },
    { budget: 100, posted: 130, pending: 0, rollover: true, carryover: -40 },
    { budget: 100, posted: 130, pending: 0, rollover: true, carryover: 60 },
  ];

  it.each(cases)('[A12] (P1) totals and the "of" line match for %o', (over) => {
    const b = budget({ id: 'food', ...over });
    const available = b.available;
    const view = budgetViews(state(over));
    expect(view.totBudget).toBe(available);
    expect(view.rows[0].over).toBe(b.posted + b.pending > available);
    expect(budgetDetail(state(over), 'food')?.ofBudget).toContain(`$${available}`);
  });
});

describe('pace stays on the base target, not the spendable', () => {
  // budget 100, envelope 1000, half-way through: pace target is 50 (not 500), so 800 spent is $750
  // over plan, with little room left per day.
  const roomy = { budget: 100, posted: 800, pending: 0, available: 1000 };

  it('[A5] (P0) budgetDetail flags over plan', () => {
    expect(budgetDetail(state(roomy), 'food')?.statusLabel).toBe('Over plan — ease up');
  });
});
