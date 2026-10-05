// WHIT-747 QA — the goal engine's targetReached flag feeding the celebration step count, run
// end-to-end through the real balanceGoalView + celebrationSteps: manual goals (owed stored
// positive), a debt paid to $0, and a finished goal counting its target as the final step.
import { describe, it, expect } from '@jest/globals';
import { balanceGoalView, BalanceGoal } from '../context';
import { celebrationSteps } from '../checkpointCelebration';

const CYCLE = { length: 14, last_pay_date: '2026-06-06' };
const TODAY = new Date(2026, 6, 11);

function goal(over: Partial<BalanceGoal> = {}): BalanceGoal {
  return { direction: 'grow', target_amount: 10000, target_date: '2026-08-15', account_id: 'up-spending', ...over };
}
const view = (g: BalanceGoal, balance: number | null = null) => balanceGoalView({ goal: g, balance, payCycle: CYCLE }, TODAY);

describe('targetReached → celebration steps (WHIT-747 QA)', () => {
  // [A16]
  it('a manual debt (owed stored positive) is reached at or below the target owed', () => {
    const debt = (owed: number) => goal({ direction: 'paydown', target_amount: 1000, account_id: null, manual_balance: owed });
    expect(view(debt(1001)).targetReached).toBe(false);
    expect(view(debt(1000)).targetReached).toBe(true);
    expect(view(debt(0)).targetReached).toBe(true);
  });

  // [A17]
  it('a synced debt with a $0 target is reached only once fully paid', () => {
    const car = goal({ direction: 'paydown', target_amount: 0, account_id: 'up-car' });
    expect(view(car, -0.01).targetReached).toBe(false);
    expect(view(car, 0).targetReached).toBe(true);
  });

  // [A18]
  it('a manual savings goal with no balance yet is unknown, so it never counts a step', () => {
    const v = view(goal({ account_id: null, manual_balance: null }));
    expect(v.targetReached).toBeNull();
    expect(celebrationSteps(v)).toBeNull();
  });

  // [A19]
  it('a finished goal counts every checkpoint plus the target; one short of it does not', () => {
    const ladder = goal({ checkpoints: [{ amount: 2000 }, { amount: 5000 }] });
    expect(celebrationSteps(view(ladder, 10000))).toBe(3);
    expect(celebrationSteps(view(ladder, 9999.99))).toBe(2);
  });

  // [A20]
  it('a goal with no checkpoints has exactly one step: its target', () => {
    expect(celebrationSteps(view(goal(), 400))).toBe(0);
    expect(celebrationSteps(view(goal(), 10000))).toBe(1);
  });
});
