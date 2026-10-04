// WHIT-727 — urgentFirst ordering rules and the behindPace flag it ranks on.
import { describe, it, expect } from '@jest/globals';
import { budgetViews } from '../context';
import { urgentFirst } from '../budgetOrder';
import type { Budget } from '../model';
import type { Category } from '../types';
import { makeState, cat, budget } from './factory';
import { budgetRowFor } from './support/budgetsTab';

// Halfway through a 14-day cycle, so a $100 budget's pace is $50.
const rowsFor = (categories: Category[], budgets: Budget[]) =>
  budgetViews(makeState({ categories, budgets, cycleLen: 14, daysLeft: 7 })).rows;
const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

const groceries = cat({ id: 'groceries', name: 'Groceries', bucket: 'Living' });
const dining = cat({ id: 'dining', name: 'Dining' });
const shopping = cat({ id: 'shopping', name: 'Shopping' });
const coffee = cat();
const latte = cat({ id: 'latte', name: 'Lattes', parent: 'coffee' });
const salary = cat({ id: 'salary', name: 'Salary', bucket: 'Income' });
const bonus = cat({ id: 'bonus', name: 'Bonus', bucket: 'Income', parent: 'salary' });

describe('urgentFirst', () => {
  it('keeps two over-budget rows in their input order', () => {
    const rows = rowsFor([groceries, dining, shopping], [
      budget({ id: 'groceries', budget: 100, posted: 50, pending: 0 }),
      budget({ id: 'dining', budget: 100, posted: 150, pending: 0 }),
      budget({ id: 'shopping', budget: 100, posted: 120, pending: 0 }),
    ]);
    expect(ids(urgentFirst(rows))).toEqual(['dining', 'shopping', 'groceries']);
  });

  it('lifts an on-pace parent with a behind-pace sub above an on-pace budget, sub still under it', () => {
    const rows = rowsFor([groceries, coffee, latte], [
      budget({ id: 'groceries', budget: 100, posted: 50, pending: 0 }),
      budget({ id: 'coffee', budget: 200, posted: 100, pending: 0 }),
      budget({ id: 'latte', budget: 20, posted: 15, pending: 0 }),
    ]);
    const ordered = urgentFirst(rows);
    expect(ids(ordered)).toEqual(['coffee', 'latte', 'groceries']);
    expect(ordered.map((r) => r.depth)).toEqual([0, 1, 0]);
  });

  it('leaves a nested earning family last and in order', () => {
    const rows = rowsFor([salary, bonus, groceries, dining], [
      budget({ id: 'salary', budget: 5000, posted: 1000, pending: 0 }),
      budget({ id: 'bonus', budget: 500, posted: 0, pending: 0 }),
      budget({ id: 'groceries', budget: 100, posted: 50, pending: 0 }),
      budget({ id: 'dining', budget: 100, posted: 150, pending: 0 }),
    ]);
    expect(ids(urgentFirst(rows))).toEqual(['dining', 'groceries', 'salary', 'bonus']);
  });

  it('keeps the budgetViews order when every row is on pace', () => {
    const rows = rowsFor([groceries, dining, shopping], [
      budget({ id: 'groceries', budget: 100, posted: 50, pending: 0 }),
      budget({ id: 'dining', budget: 100, posted: 40, pending: 0 }),
      budget({ id: 'shopping', budget: 100, posted: 50, pending: 0 }),
    ]);
    expect(ids(urgentFirst(rows))).toEqual(['groceries', 'dining', 'shopping']);
  });
});

describe('behindPace', () => {
  it('is true for a row past its pace line', () => {
    const row = budgetRowFor({ budget: 100, posted: 70, pending: 0 });
    expect(row.behindPace).toBe(true);
    expect(row.paceLabel).toMatch(/behind pace$/);
  });

  it('is false for an on-pace, over-budget or income row', () => {
    expect(budgetRowFor({ budget: 100, posted: 50, pending: 0 }).behindPace).toBe(false);
    expect(budgetRowFor({ budget: 100, posted: 150, pending: 0 }).behindPace).toBe(false);
    expect(budgetRowFor({ id: 'salary', budget: 5000, posted: 0, pending: 0 }, salary).behindPace).toBe(false);
  });
});
