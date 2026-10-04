// WHIT-707 — the Budgets tab rows: Spending before Earning, income reads "earned · next pay",
// pending gets its own words, and an over-budget row offers a spread instead of piling on red.
import { describe, it, expect } from '@jest/globals';
import { budgetViews } from '../context';
import { C } from '../theme';
import { makeState, cat, budget } from './factory';

const salary = cat({ id: 'salary', name: 'Salary', color: '#35d9a0', bucket: 'Income' });
const coffee = cat();
const latte = cat({ id: 'latte', name: 'Lattes', bucket: 'Lifestyle', parent: 'coffee' });
const rent = cat({ id: 'rent', name: 'Rent', bucket: 'Living', color: '#7aa2ff' });
const gym = cat({ id: 'gym', name: 'Gym', bucket: 'Lifestyle', color: '#f0a0c0' });

describe('budgetViews rows (WHIT-707)', () => {
  it('lists Spending then Earning, with income, pending and over-budget wording', () => {
    // Income listed FIRST in the input; elapsed 0.5 (14-day cycle, 6 days left → payday within a week).
    const s = {
      ...makeState({
        categories: [salary, coffee, latte, rent, gym],
        budgets: [
          budget({ id: 'salary', budget: 5000, posted: 1000, pending: 0 }),
          budget({ id: 'coffee', budget: 100, posted: 40, pending: 10 }),
          budget({ id: 'latte', budget: 30, posted: 5, pending: 0 }),
          budget({ id: 'rent', budget: 100, posted: 120, pending: 0 }),                     // over, spreadable
          budget({ id: 'gym', budget: 100, posted: 120, pending: 0, rollover: true }),      // over, can't spread
        ],
        cycleLen: 14, daysLeft: 6,
      }),
      nextPayday: '2026-10-09', // a Friday
    };
    const { rows } = budgetViews(s);
    const byId = (id: string) => rows.find((r) => r.id === id)!;

    // Spending first (nesting kept: the sub stays right after its parent), Earning last.
    expect(rows.map((r) => r.id)).toEqual(['coffee', 'latte', 'rent', 'gym', 'salary']);
    expect(rows.map((r) => r.section)).toEqual(['spending', 'spending', 'spending', 'spending', 'earning']);

    // Income: no even-pace line, no today marker, "earned · next pay ~Fri"; right side unchanged.
    const income = byId('salary');
    expect(income.spentLabel).toBe('$1,000 earned · next pay ~Fri');
    expect(income.paceLabel).toBe('');
    expect(income.showTarget).toBe(false);
    expect(income.spreadPrefill).toBeNull();
    expect(income.remainAmount).toBe('$4,000');
    expect(income.remainLabel).toBe('to go');

    // Pending gets its own words; the limit stays visible. No pending → unchanged.
    expect(byId('coffee').spentLabel).toBe('$50 of $100 · $10 pending');
    expect(byId('coffee').showTarget).toBe(true);
    expect(byId('latte').spentLabel).toBe('$5 of $30');

    // Over budget + spreadable: rose on amount and bar; the pace line becomes the spread link.
    const over = byId('rent');
    expect(over.remainColor).toBe(C.bad);
    expect(over.postedColor).toBe(C.bad);
    expect(over.paceLabel).toBe('Spread it over pay cycles →');
    expect(over.paceColor).not.toBe(C.bad);
    expect(over.spreadPrefill).toBe(20);

    // Over budget but rollover (can't spread): no pace line, the red amount says it once (WHIT-712).
    const quiet = byId('gym');
    expect(quiet.paceLabel).toBe('');
    expect(quiet.remainAmount).toBe('$20');
    expect(quiet.spreadPrefill).toBeNull();

    // Payday more than 6 days away reads as a date, not a weekday; no payday → just "earned".
    const far = budgetViews({ ...s, daysLeft: 14, nextPayday: '2026-10-17' }).rows.find((r) => r.id === 'salary')!;
    expect(far.spentLabel).toBe('$1,000 earned · next pay ~17 Oct');
    const none = budgetViews({ ...s, nextPayday: undefined }).rows.find((r) => r.id === 'salary')!;
    expect(none.spentLabel).toBe('$1,000 earned');
  });
});
