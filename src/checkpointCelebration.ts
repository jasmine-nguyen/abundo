// WHIT-481 — the pure heart of the in-app checkpoint celebration.
//
// The Goals screen remembers each goal's "N of M reached" count (WHIT-478's
// balanceGoalView.checkpointsReached) from the last data it showed. On fresh data, this
// diff says which goals crossed a NEW rung since then — the client-side signal the confetti
// fires on, deliberately independent of the server's NOTIFY#GOALCHECKPOINT push marker.
//
// Every rule here is a "don't burst when we shouldn't" guard:
//  - reached === null (balance not known yet): never seeds a burst; a prior count is KEPT so a
//    later known-and-higher balance still celebrates (a synced goal can go number → null → number
//    when its account briefly drops out of the balances payload).
//  - a goal we've never seen at a real number: seeded silently, no burst — this is BOTH the
//    first-load / hydrate guard AND the "brand-new goal already past a rung" guard, in one rule.
//  - count up vs last seen: burst.
//  - count same or down (a balance that fell back below a rung): no burst, but the fresh count is
//    stored so a later re-cross re-arms.

export type ReachedSnapshot = Record<string, number>; // goalId → last-seen reached count

export interface CheckpointBurst {
  goalId: string;
  newlyReached: number; // how many rungs crossed since last seen (>= 1)
}

export interface CheckpointDiff {
  bursts: CheckpointBurst[];
  next: ReachedSnapshot; // the snapshot to remember for the next diff
}

export interface CheckpointReached {
  id: string;
  reached: number | null; // balanceGoalView.checkpointsReached (null while the balance is unknown)
}

export function diffCheckpointReached(prev: ReachedSnapshot, current: CheckpointReached[]): CheckpointDiff {
  const next: ReachedSnapshot = {};
  const bursts: CheckpointBurst[] = [];

  for (const { id, reached } of current) {
    const seen = prev[id]; // number, or undefined if never seen at a real count

    if (reached === null) {
      // Balance unknown this tick. Carry a prior count forward so a later higher balance still
      // bursts; a goal we've never counted stays unseen (falls out of `next`).
      if (seen !== undefined) next[id] = seen;
      continue;
    }

    next[id] = reached;
    if (seen !== undefined && reached > seen) {
      bursts.push({ goalId: id, newlyReached: reached - seen });
    }
  }

  return { bursts, next };
}
