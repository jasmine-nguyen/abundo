// WHIT-630: the "what can I spend this cycle" formula and the pace target, in one place so
// budgetViews, budgetDetail and spread eligibility can't drift apart.
import type { Budget } from './model';
import { elapsedFrac } from './payCycle';

// Prefer the server-computed spendable (WHIT-549); fall back to the old parts-sum only when the
// server omits it. `??` (not `||`) so a legitimate server 0 is kept.
export function availableToSpend(budget: Pick<Budget, 'available' | 'budget' | 'rollover' | 'carryover' | 'spreadAdjustment'>): number {
  return budget.available ?? (budget.budget + (budget.rollover ? budget.carryover : 0) + budget.spreadAdjustment);
}

// How much of the base target should be spent by now, at an even pace through the cycle.
export function paceTarget(budget: Pick<Budget, 'budget'>, cycle: { cycleLen: number; daysLeft: number }): number {
  return budget.budget * elapsedFrac(cycle);
}

// Where the base pace target sits on a bar scaled to `den` (WHIT-732), so the tick matches the words.
export function pacePct(target: number, den: number): number {
  return Math.max(0, Math.min(100, Math.round((target / den) * 100)));
}

// Whether to say "over plan" (WHIT-732): ahead of pace AND the room left per day is under half the
// daily plan. A plain "runs out before payday" projection is the same test as "ahead of pace".
export function paceWarning(
  row: { spent: number; target: number; available: number; over: boolean },
  cycle: { cycleLen: number; daysLeft: number },
): boolean {
  if (row.over) return false;
  if (row.spent - row.target <= 0.5) return false;
  const dailyLeft = (row.available - row.spent) / Math.max(1, cycle.daysLeft);
  return dailyLeft < row.available / cycle.cycleLen / 2;
}
