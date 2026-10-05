// WHIT-739: a bill paid in full in one go (nothing left, one counting charge) has nothing to slow
// down — no "over plan" on the detail, and the row isn't flagged or ranked as urgent. The calm detail
// status reads "On track for payday". A budget used up by several charges still warns.
import { describe, it, expect } from '@jest/globals';
import { budgetViews, budgetDetail } from '../context';
import type { Budget } from '../model';
import type { Transaction } from '../types';
import { paceWarning } from '../budgetMath';
import { urgentFirst } from '../budgetOrder';
import { C } from '../theme';
import { makeState, cat, budget, txn } from './factory';
import { budgetDetailFor, rowIds } from './support/budgetsTab';

const MORTGAGE = cat({ id: 'mortgage', name: 'Mortgage', bucket: 'Living' });
const MORTGAGE_CYCLE = { cycleLen: 30, daysLeft: 21 };
const paidMortgage = budget({ id: 'mortgage', budget: 3667, posted: 3667, pending: 0 });
const charge = (amount: number, over = {}) =>
  txn({ transaction_id: `m${amount}`, category: 'mortgage', amount: -amount, ...over });

const mortgageDetail = (transactions: Transaction[], b: Partial<Budget> = {}) => budgetDetail(
  makeState({ categories: [MORTGAGE], budgets: [{ ...paidMortgage, ...b }], transactions, ...MORTGAGE_CYCLE }),
  'mortgage',
)!;

describe('paceWarning — paid in one go', () => {
  const row = { spent: 3667, target: 1100, available: 3667, over: false };
  it('one charge and $0 left → no warning', () => {
    expect(paceWarning({ ...row, oneCharge: true }, MORTGAGE_CYCLE)).toBe(false);
  });
  it('no one-charge flag and $0 left → still warns', () => {
    expect(paceWarning(row, MORTGAGE_CYCLE)).toBe(true);
  });
  it('one charge but $0.01 left, far ahead → still warns', () => {
    expect(paceWarning({ ...row, spent: 3666.99, oneCharge: true }, MORTGAGE_CYCLE)).toBe(true);
  });
});

describe('budgetViews — paid mortgage row', () => {
  const state = (extra = {}) => ({
    ...makeState({ categories: [MORTGAGE, cat()], budgets: [paidMortgage, budget({ budget: 100, posted: 85, pending: 0 })], ...MORTGAGE_CYCLE }),
    ...extra,
  });

  it('with the one-charge set, the paid mortgage is not behind pace', () => {
    const row = budgetViews(state({ oneChargeIds: new Set(['mortgage']) })).rows.find((r) => r.id === 'mortgage')!;
    expect(row.behindPace).toBe(false);
  });

  it('without the set, it is still behind pace', () => {
    const row = budgetViews(state()).rows.find((r) => r.id === 'mortgage')!;
    expect(row.behindPace).toBe(true);
  });

  it('urgentFirst: a real over-plan row outranks the paid mortgage', () => {
    const rows = budgetViews(
      { ...makeState({ categories: [MORTGAGE, cat()], budgets: [paidMortgage, budget({ budget: 100, posted: 85, pending: 0 })], cycleLen: 14, daysLeft: 7 }), oneChargeIds: new Set(['mortgage']) },
    ).rows;
    expect(rowIds(urgentFirst(rows))).toEqual(['coffee', 'mortgage']);
  });
});

describe('budgetDetail — paid in one go', () => {
  it('one counting charge of the full amount → "On track for payday", green', () => {
    const d = mortgageDetail([charge(3667)]);
    expect(d.statusLabel).toBe('On track for payday');
    expect(d.statusColor).toBe(C.good);
  });

  it('two charges that use it up → still "Over plan — ease up"', () => {
    const d = mortgageDetail([charge(1833.5, { transaction_id: 'a' }), charge(1833.5, { transaction_id: 'b' })]);
    expect(d.statusLabel).toBe('Over plan — ease up');
  });

  it('one counting charge plus one excluded charge → quiet', () => {
    const d = mortgageDetail([charge(3667), charge(10, { transaction_id: 'x', budget_excluded: true })]);
    expect(d.statusLabel).toBe('On track for payday');
  });

  it('over budget with one charge is still red', () => {
    const d = mortgageDetail([charge(3700)], { posted: 3700 });
    expect(d.statusLabel).toBe('Over budget — ease up');
    expect(d.statusColor).toBe(C.bad);
  });

  it('the calm default reads "On track for payday", not "On target — keep it up"', () => {
    const d = budgetDetailFor({ budget: 100, posted: 0 });
    expect(d.statusLabel).toBe('On track for payday');
  });
});
