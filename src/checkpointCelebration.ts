// WHIT-481 / WHIT-811 — the pure heart of the in-app checkpoint celebration.
//
// The Goals screen remembers, per goal, every step it showed last time (each checkpoint or mortgage
// milestone, plus a goal's target as its final step) and whether it was reached. On fresh data, this
// diff says which goals crossed a step since then — the client-side signal the confetti fires on,
// deliberately independent of the server's NOTIFY#GOALCHECKPOINT push marker.
//
// A step is keyed by its id AND amount, so moving its amount makes it a new step. The rules:
//  - steps === null (balance not known yet): never bursts; the prior entry is KEPT so a later known
//    balance still celebrates.
//  - a goal never seen, or a step not in the last snapshot (added or moved): seeded silently.
//  - a step reached now that was unreached last time: burst. One burst per goal, naming the highest
//    such step; bursts from several goals come back in the order given.
//  - a step that fell back to unreached is stored as unreached, so a later re-cross re-arms.

export type StepSnapshot = Record<string, Record<string, boolean>>; // goalId → stepKey → reached

// WHIT-747: where the snapshot is saved on the phone, so a crossing made while the app was closed
// still celebrates on the next open.
export const CHECKPOINT_SNAPSHOT_KEY = 'abundo.checkpointSnapshot';

export interface CelebrationStep {
  key: string;
  reached: boolean;
  label: string; // what the banner says when this step is the one reached
}

export interface GoalSteps {
  id: string;
  steps: CelebrationStep[] | null; // in climb order; null while the balance is unknown
}

export interface CheckpointBurst {
  goalId: string;
  label: string;
}

export interface CheckpointDiff {
  bursts: CheckpointBurst[];
  next: StepSnapshot; // the snapshot to remember for the next diff
}

export function stepKey(id: string, amount: number): string {
  return `${id}@${amount}`;
}

export function diffCheckpointReached(prev: StepSnapshot, current: GoalSteps[]): CheckpointDiff {
  const next: StepSnapshot = {};
  const bursts: CheckpointBurst[] = [];

  for (const { id, steps } of current) {
    const seen = prev[id];
    if (steps === null) {
      if (seen) next[id] = seen;
      continue;
    }

    next[id] = Object.fromEntries(steps.map((step) => [step.key, step.reached]));
    if (!seen) continue;

    const newlyReached = steps.filter((step) => step.reached && seen[step.key] === false);
    if (newlyReached.length > 0) {
      bursts.push({ goalId: id, label: newlyReached[newlyReached.length - 1].label });
    }
  }

  return { bursts, next };
}
