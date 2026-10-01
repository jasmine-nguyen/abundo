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
