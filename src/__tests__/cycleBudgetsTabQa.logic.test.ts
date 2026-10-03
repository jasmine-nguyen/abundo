// WHIT-703 slice 2 QA — Budgets-tab edges the acceptance test doesn't reach: nesting (an
// unbudgeted parent, a grandchild), a borrowed rollover, a server with no `available`, past
// cycles that still carry rollover/spread data, a corrupt parent loop, and what reaches the
// workbook (target 0 budgets, an empty `budgets`). Expected rows are written by hand.
import { describe, it, expect } from '@jest/globals';
import { unzipSync, strFromU8 } from 'fflate';
import { BUDGET_HEADER, buildBudgetRows, buildCycleWorkbook, buildTransactionRows } from '../cycleExport';
import { toBudget } from '../model';
import type { BudgetRollup, CycleTransaction, CycleTransactions } from '../api';
import type { Category } from '../types';
import { cat } from './factory';

const CATS: Category[] = [
  cat({ id: 'home', name: 'Home', bucket: 'Living', parent: null }),
  cat({ id: 'utilities', name: 'Utilities', bucket: 'Living', parent: 'home' }),
  cat({ id: 'power', name: 'Power', bucket: 'Living', parent: 'utilities' }),
  cat({ id: 'car', name: 'Car', bucket: 'Living', parent: null }),
  cat({ id: 'rego', name: 'Rego', bucket: 'Living', parent: 'car' }),
  cat({ id: 'holiday', name: 'Holiday', bucket: 'Savings', parent: null }),
  cat({ id: 'emergency', name: 'Emergency', bucket: 'Savings', parent: null }),
  // A corrupt parent loop: each names the other as its parent.
  cat({ id: 'loop_a', name: 'Loop A', bucket: 'Lifestyle', parent: 'loop_b' }),
  cat({ id: 'loop_b', name: 'Loop B', bucket: 'Lifestyle', parent: 'loop_a' }),
];
const category = (id: string) => CATS.find((c) => c.id === id);

function budgets(rollups: Record<string, BudgetRollup>) {
  return Object.entries(rollups).map(([id, rollup]) => toBudget(id, rollup));
}

function data(rollups?: Record<string, BudgetRollup>, transactions: CycleTransaction[] = []): CycleTransactions {
  return { start: '2026-07-01', end: '2026-07-25', transactions, ...(rollups ? { budgets: rollups } : {}) };
}

// Each Budgets-tab row's cell texts/values in sheet2.xml, read straight from the workbook bytes.
function budgetSheetRows(bytes: Uint8Array): string[][] {
  const xml = strFromU8(unzipSync(bytes)['xl/worksheets/sheet2.xml']);
  return [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map((row) =>
    [...row[1].matchAll(/<(?:t|v)(?:\s[^>]*)?>([\s\S]*?)<\/(?:t|v)>/g)].map((m) => m[1]));
}

describe('buildBudgetRows — order and the parent column', () => {
  // [B1] (P0) a budgeted child whose parent has no budget → listed at the top level, with the
  // top-level parent's name in the Parent category column.
  it('a child budget with an unbudgeted parent names its top-level parent', () => {
    const rows = buildBudgetRows(budgets({ rego: { target: 100, posted: 10, pending: 0 } }), category, false);
    expect(rows).toEqual([BUDGET_HEADER, ['Car', 'Rego', 100, 10, 0, 90, 0, 100]]);
  });

  // [B2] (P0) a budgeted grandchild follows its budgeted grandparent (server sends it first),
  // and its Parent category is the top-level name, not the unbudgeted middle category.
  it('a grandchild follows its budgeted grandparent and names the top level', () => {
    const rows = buildBudgetRows(budgets({
      power: { target: 80, posted: 20, pending: 0 },
      car: { target: 300, posted: 0, pending: 0 },
      home: { target: 900, posted: 20, pending: 0 },
    }), category, false);
    expect(rows.slice(1).map((row) => [row[0], row[1]])).toEqual([
      ['Car', 'Car'],
      ['Home', 'Home'],
      ['Home', 'Power'],
    ]);
  });

  // [B3] (P1) several Savings budgets → all listed once, after the screen's rows, in server order.
  it('Savings budgets come last in server order', () => {
    const rows = buildBudgetRows(budgets({
      emergency: { target: 50, posted: 0, pending: 0 },
      car: { target: 300, posted: 0, pending: 0 },
      holiday: { target: 70, posted: 0, pending: 0 },
    }), category, false);
    expect(rows.slice(1).map((row) => row[1])).toEqual(['Car', 'Emergency', 'Holiday']);
  });

  // [B4] (P1) a corrupt parent loop between two budgets → each budget appears exactly once.
  it('a parent loop never drops or repeats a budget', () => {
    const rows = buildBudgetRows(budgets({
      loop_a: { target: 10, posted: 1, pending: 0 },
      loop_b: { target: 20, posted: 2, pending: 0 },
    }), category, false);
    expect(rows.slice(1).map((row) => row[1]).sort()).toEqual(['Loop A', 'Loop B']);
  });
});

describe('buildBudgetRows — the numbers', () => {
  // [B5] (P0) a borrowed rollover (negative buffer) → Carry-over is negative and Available is
  // the server's spendable; Left to spend = Available − Spent.
  it('a borrowed rollover shows a negative carry-over', () => {
    const rows = buildBudgetRows(budgets({
      car: { target: 300, posted: 200, pending: 25, rollover: true, carryover: -50, available: 250 },
    }), category, false);
    expect(rows[1]).toEqual(['Car', 'Car', 300, 225, 25, 25, -50, 250]);
  });

  // [B6] (P1) an older server with no `available` → Available is target + buffer.
  it('falls back to target + carry-over when the server omits available', () => {
    const rows = buildBudgetRows(budgets({
      car: { target: 300, posted: 100, pending: 0, rollover: true, carryover: 40 },
    }), category, false);
    expect(rows[1]).toEqual(['Car', 'Car', 300, 100, 0, 240, 40, 340]);
  });

  // [B7] (P0) last cycle ignores any rollover/spread figures in the payload: Available = today's
  // target, Carry-over blank, Left to spend = target − last cycle's spend.
  it('last cycle ignores rollover and spread figures', () => {
    const rows = buildBudgetRows(budgets({
      car: { target: 300, posted: 100, pending: 20, rollover: true, carryover: 40, available: 340 },
      home: { target: 900, posted: 1000, pending: 0, available: 1100,
        spread: { amount: 800, cycles: 4, index: 0, adjustment: 200 } },
    }), category, true);
    expect(rows).toEqual([
      ['Parent category', 'Category', 'Budget (current)', 'Spent', 'Pending', 'Left to spend', 'Carry-over', 'Available'],
      ['Car', 'Car', 300, 120, 20, 180, null, 300],
      ['Home', 'Home', 900, 1000, 0, -100, null, 900],
    ]);
  });

  // [B8] (P1) building last cycle's header doesn't change the shared header for this cycle.
  it('the past-cycle header does not leak into the next export', () => {
    buildBudgetRows([], category, true);
    expect(buildBudgetRows([], category, false)).toEqual([BUDGET_HEADER]);
    expect(BUDGET_HEADER[2]).toBe('Budget');
  });
});

describe('buildCycleWorkbook — what reaches the Budgets tab', () => {
  // [B9] (P1) an empty `budgets` (a server with no targets) → titles only.
  it('an empty budgets map gives the header row only', () => {
    expect(budgetSheetRows(buildCycleWorkbook(data({}), category, false))).toEqual([BUDGET_HEADER]);
  });

  // [B10] (P1) a target of 0 is dropped, as on the Budgets screen.
  it('a zero target is left out', () => {
    const rows = budgetSheetRows(buildCycleWorkbook(data({
      car: { target: 0, posted: 5, pending: 0 },
      rego: { target: 100, posted: 10, pending: 0 },
    }), category, false));
    expect(rows.map((row) => row[1])).toEqual(['Category', 'Rego']);
  });

  // [B11] (P0) adding budgets never changes the Transactions tab.
  it('the Transactions tab is the same with or without budgets', () => {
    const transactions: CycleTransaction[] = [{
      transaction_id: 't1', date: '2026-07-02', amount: -12.5, category: 'rego', status: 'posted',
      merchant_name: 'VicRoads', description: 'VICROADS', account_name: 'Everyday',
      counts_to_budget_effective: true,
    } as CycleTransaction];
    const sheet1 = (bytes: Uint8Array) => strFromU8(unzipSync(bytes)['xl/worksheets/sheet1.xml']);
    const withBudgets = sheet1(buildCycleWorkbook(data({ rego: { target: 100, posted: 12.5, pending: 0 } }, transactions), category, false));
    const without = sheet1(buildCycleWorkbook(data(undefined, transactions), category, false));
    expect(withBudgets).toBe(without);
    expect(buildTransactionRows(transactions, category)[1]).toEqual(
      ['2026-07-02', -12.5, 'Car', 'Rego', 'VicRoads', 'Everyday', 'posted', 'Yes']);
  });
});
