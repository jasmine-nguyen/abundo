// WHIT-811: shared builders for the celebration's per-goal steps, used by the diff and hook tests.
// Step n of goal `id` is keyed `${id}-n@n` and labelled `${id} step n`.
import { GoalSteps, StepSnapshot, stepKey } from '../../checkpointCelebration';

const key = (id: string, n: number) => stepKey(`${id}-${n}`, n);

// One goal's steps, in climb order, from its reached flags; null = balance unknown.
export function goalSteps(id: string, reached: boolean[] | null): GoalSteps {
  if (reached === null) return { id, steps: null };
  return { id, steps: reached.map((flag, n) => ({ key: key(id, n), reached: flag, label: `${id} step ${n}` })) };
}

// What the Goals hub saves for a goal with checkpoints a ($2,000) and b ($5,000) and a $10,000
// target, and for mortgage milestones m1 ($600,000) and m2 ($500,000).
export const holidaySaved = (a: boolean, b: boolean, target: boolean) => ({ 'a@2000': a, 'b@5000': b, 'target@10000': target });
export const mortgageSaved = (m1: boolean, m2: boolean) => ({ 'm1@600000': m1, 'm2@500000': m2 });

// The saved snapshot for goals built with goalSteps.
export function stepSnapshot(goals: Record<string, boolean[]>): StepSnapshot {
  return Object.fromEntries(
    Object.entries(goals).map(([id, reached]) => [id, Object.fromEntries(reached.map((flag, n) => [key(id, n), flag]))]),
  );
}
