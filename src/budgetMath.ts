// WHIT-630: the pace target, in one place so budgetViews, budgetDetail and spread eligibility
// can't drift apart. The spendable is the server's `available` (WHIT-549), read as sent.
import type { Budget } from './model';
import { elapsedFrac } from './payCycle';
import type { Transaction } from './types';

// How much of the base target should be spent by now, at an even pace through the cycle.
export function paceTarget(budget: Pick<Budget, 'budget'>, cycle: { cycleLen: number; daysLeft: number }): number {
  return budget.budget * elapsedFrac(cycle);
}

// Where the base pace target sits on a bar scaled to `den` (WHIT-732), so the tick matches the words.
export function pacePct(target: number, den: number): number {
  return Math.max(0, Math.min(100, Math.round((target / den) * 100)));
}

// Whether a transaction counts toward budgets on the client: the bank said it
// counts AND the user hasn't manually excluded it ("mark as transfer", WHIT-296).
// Single source of truth so the uncategorized tab, its count, the row's actionable
// "Uncategorized" state, and the "apply to every {merchant}" sweep all drop an
// excluded transfer the same way the server does.
export function contributesToBudget(t: Transaction): boolean {
  // `!!` so an omitted counts_to_budget (undefined off the wire) returns a real `false`, not
  // `undefined` — otherwise it leaks through to transactionView.tappable, whose type is boolean.
  return !!t.counts_to_budget && !t.budget_excluded;
}

export function paidInOneGo(transactions: Transaction[]): boolean {
  return transactions.filter(contributesToBudget).length === 1;
}

export function nothingLeft(spent: number, available: number): boolean {
  const left = available - spent;
  return left >= 0 && left < 0.005;
}

// Whether to say "over plan" (WHIT-732): ahead of pace AND the room left per day is under half the
// daily plan. A plain "runs out before payday" projection is the same test as "ahead of pace".
export function paceWarning(
  row: { spent: number; target: number; available: number; over: boolean; oneCharge?: boolean },
  cycle: { cycleLen: number; daysLeft: number },
): boolean {
  if (row.over) return false;
  // A bill paid in one go with nothing left has nothing to slow down (WHIT-739).
  if (row.oneCharge && nothingLeft(row.spent, row.available)) return false;
  if (row.spent - row.target <= 0.5) return false;
  const dailyLeft = (row.available - row.spent) / Math.max(1, cycle.daysLeft);
  return dailyLeft < row.available / cycle.cycleLen / 2;
}
