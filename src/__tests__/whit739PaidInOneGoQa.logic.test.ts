// WHIT-739 QA: the "paid in one go" rule's edges — what counts as one charge, the cent boundary of
// "nothing left", a rollover/server envelope, and that the one-charge flag alone never silences a
// budget that still has money left.
import { describe, it, expect } from '@jest/globals';
import { budgetDetail } from '../context';
import type { Budget } from '../model';
import type { Transaction } from '../types';
import { nothingLeft, paceWarning, paidInOneGo } from '../budgetMath';
import { C } from '../theme';
import { makeState, cat, budget, txn } from './factory';
import { MORTGAGE_RECORD } from './support/categories';

const MORTGAGE = cat({ ...MORTGAGE_RECORD });
const CYCLE = { cycleLen: 30, daysLeft: 21 };
const charge = (id: string, amount: number, over: Partial<Transaction> = {}) =>
  txn({ transaction_id: id, category: 'mortgage', amount: -amount, ...over });
const mortgage = (b: Partial<Budget>) => budget({ id: 'mortgage', budget: 3667, posted: 3667, pending: 0, ...b });
const detail = (b: Partial<Budget>, transactions: Transaction[]) =>
  budgetDetail(makeState({ categories: [MORTGAGE], budgets: [mortgage(b)], transactions, ...CYCLE }), 'mortgage')!;

describe('paidInOneGo', () => {
  // [A1]
  it('no charges → not paid in one go', () => {
    expect(paidInOneGo([])).toBe(false);
  });
  it('only an excluded charge → not paid in one go', () => {
    expect(paidInOneGo([charge('a', 3667, { budget_excluded: true })])).toBe(false);
  });
  it('a charge that does not count to budget is ignored', () => {
    expect(paidInOneGo([charge('a', 3667), charge('b', 5, { counts_to_budget: false })])).toBe(true);
  });
  it('two counting charges → not one go', () => {
    expect(paidInOneGo([charge('a', 3000), charge('b', 667)])).toBe(false);
  });
});

describe('nothingLeft — the cent boundary', () => {
  // [A2]
  it.each([
    [3667, 3667, true],
    [3666.996, 3667, true],
    [3666.99, 3667, false],
    [3667.01, 3667, false],
  ])('spent %p of %p → %p', (spent, available, expected) => {
    expect(nothingLeft(spent, available)).toBe(expected);
  });
});

describe('paceWarning — the one-charge flag needs nothing left', () => {
  // [A3]
  it('a fraction of a cent left, one charge → quiet', () => {
    expect(paceWarning({ spent: 3666.996, target: 1100, available: 3667, over: false, oneCharge: true }, CYCLE)).toBe(false);
  });
});

describe('budgetDetail — envelope bigger than the base budget', () => {
  // [A4] rollover buffer: $4,000 available, all paid by one charge → quiet.
  it('rollover: one charge using the whole available envelope → "On track for payday"', () => {
    const d = detail({ posted: 4000, rollover: true, carryover: 333 }, [charge('a', 4000)]);
    expect(d.statusLabel).toBe('On track for payday');
    expect(d.statusColor).toBe(C.good);
  });
  // [A4b] the server-computed available is the envelope.
  it('server available: one charge using it all → quiet; a dollar short of it → still muted', () => {
    expect(detail({ posted: 3800, available: 3800 }, [charge('a', 3800)]).statusLabel).toBe('On track for payday');
    expect(detail({ posted: 3799, available: 3800 }, [charge('a', 3799)]).statusLabel).toBe('Over plan — ease up');
  });
  // [A6] a pending-only single charge counts as the one go too.
  it('one pending charge paying it in full → quiet', () => {
    const d = detail({ posted: 0, pending: 3667 }, [charge('a', 3667, { status: 'pending' })]);
    expect(d.statusLabel).toBe('On track for payday');
  });
});
