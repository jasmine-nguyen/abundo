// WHIT-748 — shared setup for the goal pace pill + dollars suites. Pinned calendar: start Jun6 →
// target Aug15 = 70 days; Sat 11 Jul 2026 = 35 elapsed → expected fill 0.5.
import type { installFakeServer } from './fakeServer';
import type { GoalRecord } from '../../api';
import { balanceGoalView, BalanceGoal } from '../../context';
import { seedGoalsHub } from './goalsScreen';
import { EMPTY_LOAN_FACTS } from '../factory';

export const GOAL_CYCLE = { length: 14, last_pay_date: '2026-06-06' };
export const GOAL_TODAY = new Date(2026, 6, 11); // Sat 11 Jul 2026
export const GOAL_START = { start_date: '2026-06-06', target_date: '2026-08-15' };

export function goal(over: Partial<BalanceGoal> = {}): BalanceGoal {
  return { direction: 'grow', target_amount: 10000, target_date: '2026-08-15', account_id: 'up-spending', ...over };
}
export const view = (g: BalanceGoal, balance: number | null = null) =>
  balanceGoalView({ goal: g, balance, payCycle: GOAL_CYCLE }, GOAL_TODAY);

export const growGoal = (id: string, over: Partial<GoalRecord> = {}): GoalRecord => ({
  id, name: `Grow ${id}`, icon: 'wallet', direction: 'grow', target_amount: 10000, target_date: '2026-08-15', account_id: `acct-${id}`, ...over,
});

export function seedPaceHub(server: ReturnType<typeof installFakeServer>, goals: GoalRecord[], balances: Record<string, number>) {
  seedGoalsHub(server, {
    goals,
    payCycle: GOAL_CYCLE,
    balances,
    loanFacts: EMPTY_LOAN_FACTS,
    homeLoan: { balance: 596642.43, asOf: '2026-07-04T00:00:00Z' },
  });
}
