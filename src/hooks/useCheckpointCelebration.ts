// WHIT-481 — holds the Goals screen's "last shown" checkpoint counts and drives the confetti.
//
// The snapshot lives in a ref, NOT state: it's what lets us compare "last shown" against fresh
// data without itself causing a redraw. Because the ref starts empty, the FIRST effect run seeds
// every goal and bursts nothing — that's the no-burst-on-load guard, even though the effect runs
// on mount. `counts` must be memoised by the caller so a plain redraw (same identity) doesn't
// re-run the effect; a real balance change gives it a new identity and re-runs it.
import { useEffect, useRef, useState } from 'react';
import { diffCheckpointReached, ReachedSnapshot } from '../checkpointCelebration';

export interface CheckpointCount {
  id: string;
  name: string;
  reached: number | null;
}

export interface CheckpointCelebration {
  // A counter that increments on each new burst; the overlay re-fires when it changes.
  celebrationKey: number;
  // The bursting goal's name and how many rungs it just crossed, for the celebration copy.
  label: string | null;
  newlyReached: number;
}

export function useCheckpointCelebration(counts: CheckpointCount[]): CheckpointCelebration {
  const lastShown = useRef<ReachedSnapshot>({});
  const [state, setState] = useState({ key: 0, label: null as string | null, newlyReached: 0 });

  useEffect(() => {
    const { bursts, next } = diffCheckpointReached(
      lastShown.current,
      counts.map((c) => ({ id: c.id, reached: c.reached })),
    );
    lastShown.current = next;
    if (bursts.length === 0) return;

    // One burst per refresh, even if several goals ticked up — labelled off the first.
    const first = bursts[0];
    const goal = counts.find((c) => c.id === first.goalId);
    setState((prev) => ({ key: prev.key + 1, label: goal?.name ?? null, newlyReached: first.newlyReached }));
  }, [counts]);

  return {
    celebrationKey: state.key,
    label: state.label,
    newlyReached: state.newlyReached,
  };
}
