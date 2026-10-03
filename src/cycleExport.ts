// WHIT-700 / WHIT-703: turn one pay cycle's data into the Insights export workbook (.xlsx).
// Pure — no screen or file access — so it runs in the fast logic tests.
import type { CycleTransaction, CycleTransactions } from './api';
import type { Category } from './types';
import type { Budget } from './model';
import { selectBudgets } from './queries';
import { budgetViews } from './context';
import { availableToSpend } from './budgetMath';
import { buildXlsx, type Cell } from './xlsx';

const UNCATEGORISED = 'Uncategorised';
const MAX_PARENT_STEPS = 5;

export const TRANSACTION_HEADER = [
  'Date', 'Amount', 'Parent category', 'Category', 'Description', 'Account', 'Status', 'Counts to budget',
];

export const BUDGET_HEADER = [
  'Parent category', 'Category', 'Budget', 'Spent', 'Pending', 'Left to spend', 'Carry-over', 'Available',
];

// The top-level ancestor, so the file groups by the categories the user sees at the top.
// Stops at the last known category if a parent id is unknown, and after a few steps so a
// broken parent link can't loop forever.
function topLevel(start: Category, category: (id: string) => Category | undefined): Category {
  let current = start;
  for (let step = 0; step < MAX_PARENT_STEPS; step++) {
    const parent = current.parent ? category(current.parent) : undefined;
    if (!parent) return current;
    current = parent;
  }
  return current;
}

function categoryColumns(id: string | null, category: (id: string) => Category | undefined): [string, string] {
  const own = id ? category(id) : undefined;
  if (!own) return [UNCATEGORISED, UNCATEGORISED];
  return [topLevel(own, category).name, own.name];
}

export function buildTransactionRows(
  rows: CycleTransaction[],
  category: (id: string) => Category | undefined,
): Cell[][] {
  const cells = rows.map((row): Cell[] => {
    const [parentName, categoryName] = categoryColumns(row.category, category);
    return [
      row.date,
      row.amount,
      parentName,
      categoryName,
      row.merchant_name || row.description,
      row.account_name,
      row.status,
      row.counts_to_budget_effective ? 'Yes' : 'No',
    ];
  });
  return [TRANSACTION_HEADER, ...cells];
}

// Budgets-screen order (each parent then its budgeted children), then the budgets that screen
// hides (Savings, unknown category) in server order. The pace inputs don't affect the order.
function screenOrder(budgets: Budget[], category: (id: string) => Category | undefined): Budget[] {
  const shownIds = budgetViews({ budgets, category, cycleLen: 1, daysLeft: 0 }).rows.map((row) => row.id);
  const shown = new Set(shownIds);
  const byId = new Map(budgets.map((budget) => [budget.id, budget]));
  const ordered = shownIds.map((id) => byId.get(id)!);
  return [...ordered, ...budgets.filter((budget) => !shown.has(budget.id))];
}

// Past budgets aren't saved, so last cycle is measured against today's target with a blank
// carry-over (only today's buffer is stored).
export function buildBudgetRows(
  budgets: Budget[],
  category: (id: string) => Category | undefined,
  isPastCycle: boolean,
): Cell[][] {
  const header = [...BUDGET_HEADER];
  if (isPastCycle) header[2] = 'Budget (current)';
  const cells = screenOrder(budgets, category).map((budget): Cell[] => {
    const [parentName, categoryName] = categoryColumns(budget.id, category);
    const spent = budget.posted + budget.pending;
    let carryOver: number | null = budget.rollover ? budget.carryover : budget.spreadAdjustment;
    let available = availableToSpend(budget);
    if (isPastCycle) {
      carryOver = null;
      available = budget.budget;
    }
    return [parentName, categoryName, budget.budget, spent, budget.pending, available - spent, carryOver, available];
  });
  return [header, ...cells];
}

export function buildCycleWorkbook(
  data: CycleTransactions,
  category: (id: string) => Category | undefined,
  isPastCycle: boolean,
): Uint8Array {
  const budgets = selectBudgets(data.budgets ?? {});
  return buildXlsx([
    { name: 'Transactions', rows: buildTransactionRows(data.transactions, category) },
    { name: 'Budgets', rows: buildBudgetRows(budgets, category, isPastCycle) },
  ]);
}

export function cycleFileName(start: string, end: string): string {
  return `transactions_${start}_to_${end}.xlsx`;
}
