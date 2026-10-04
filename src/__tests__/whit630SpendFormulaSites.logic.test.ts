// WHIT-630 QA: budgetViews, budgetDetail and budgetSpreadEligibility all read the spendable through
// availableToSpend and the pace through paceTarget — so each screen honours a server `available`
// (including a server 0) and keeps pace on the BASE target, not the envelope.
import { describe, it, expect } from '@jest/globals';
import { budgetViews, budgetDetail, budgetSpreadEligibility } from '../context';
import { availableToSpend } from '../budgetMath';
import { makeState, cat, budget } from './factory';

const food = cat({ id: 'food', name: 'Food', bucket: 'Living' });
const state = (b: object, daysLeft = 7) => makeState({
  categories: [food],
  budgets: [budget({ id: 'food', ...b })],
  cycleLen: 14, daysLeft,
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

  it('[A4] (P0) spread eligibility measures overspend against the server spendable', () => {
    const b = budget({ id: 'food', ...serverValue, rollover: false, carryover: 0, posted: 400, available: 1000 });
    expect(budgetSpreadEligibility(food, b)).toEqual({ entry: 'hidden', overspend: 0 });
  });
});

describe('a server 0 is kept, not replaced by the parts-sum', () => {
  const drained = { budget: 400, posted: 10, pending: 0, available: 0 };

  it('[A1] (P0) budgetViews reads the row as over budget', () => {
    const view = budgetViews(state(drained));
    expect(view.rows[0].over).toBe(true);
    expect(view.totBudget).toBe(0);
  });

  it('[A1] (P0) budgetDetail reads over and offers a spread for the whole spend', () => {
    const detail = budgetDetail(state(drained), 'food');
    expect(detail?.ofBudget).toContain('$0');
    expect(detail?.overspend).toBe(10);
  });

  it('[A1] (P0) spread eligibility offers to spread the whole spend', () => {
    expect(budgetSpreadEligibility(food, budget({ id: 'food', ...drained }))).toEqual({ entry: 'start', overspend: 10 });
  });
});

describe('the three sites agree with availableToSpend', () => {
  const cases = [
    { budget: 100, posted: 30, pending: 5, rollover: true, carryover: 50 },
    { budget: 100, posted: 30, pending: 5, rollover: false, carryover: 50 },
    { budget: 100, posted: 130, pending: 0, spreadAdjustment: -40 },
    { budget: 100, posted: 130, pending: 0, spreadAdjustment: 60 },
  ];

  it.each(cases)('[A12] (P1) totals and overspend match for %o', (over) => {
    const b = budget({ id: 'food', ...over });
    const available = availableToSpend(b);
    expect(budgetViews(state(over)).totBudget).toBe(available);
    const expectedOver = Math.round(Math.max(0, b.posted + b.pending - available) * 100) / 100;
    expect(budgetDetail(state(over), 'food')?.overspend).toBe(expectedOver);
  });
});

describe('pace stays on the base target, not the spendable', () => {
  // budget 100, envelope 1000, half-way through: pace target is 50, so 80 spent is behind pace.
  const roomy = { budget: 100, posted: 80, pending: 0, available: 1000 };

  it('[A5] (P0) budgetViews flags behind pace', () => {
    expect(budgetViews(state(roomy)).rows[0].paceLabel).toContain('behind pace');
  });

  it('[A5] (P0) budgetDetail flags ahead of pace', () => {
    expect(budgetDetail(state(roomy), 'food')?.statusLabel).toBe('Behind pace — ease up');
  });

  it('[A5] (P1) on the first day nothing is behind pace yet (on pace → no line)', () => {
    expect(budgetViews(state({ budget: 100, posted: 0, pending: 0 }, 14)).rows[0].paceLabel).toBe('');
  });
});
