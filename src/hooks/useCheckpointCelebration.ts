// WHIT-481 — holds the Goals screen's "last shown" steps and drives the confetti.
//
// WHIT-747: the snapshot is saved on the phone (AsyncStorage), so a crossing made while the app was
// closed celebrates on the next open. It's loaded once on mount; nothing is compared until it has
// loaded AND the caller says its data is `ready` (loaded, and the screen in focus) — otherwise an
// empty first paint would overwrite the saved copy. With no saved copy (a brand-new install) the
// first comparison still seeds every goal silently. The working copy lives in a ref, not state, so
// comparing never causes a redraw. `goals` must be memoised by the caller so a plain redraw (same
// identity) doesn't re-run the effect; a real balance change gives it a new identity and re-runs it.
//
// WHIT-811: bursts queue up — the banner shows the head, and `onDone` (called by the overlay when
// its banner ends) moves on to the next. An old count-style saved copy (a number per goal) has
// no steps to compare, so the diff seeds those goals silently and overwrites them.
import { useCallback, useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { CHECKPOINT_SNAPSHOT_KEY, diffCheckpointReached, GoalSteps, StepSnapshot } from '../checkpointCelebration';

export interface CheckpointCelebration {
  // A counter that increments for each banner shown; the overlay re-fires when it changes.
  celebrationKey: number;
  // Names the milestone the current banner celebrates.
  label: string | null;
  // Called when the banner ends, to show the next queued one.
  onDone: () => void;
}

function parseSnapshot(raw: string | null): StepSnapshot {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function useCheckpointCelebration(goals: GoalSteps[], ready: boolean): CheckpointCelebration {
  const lastShown = useRef<StepSnapshot>({});
  const [hydrated, setHydrated] = useState(false);
  const [state, setState] = useState({ key: 0, queue: [] as string[] });

  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(CHECKPOINT_SNAPSHOT_KEY).catch(() => null).then((raw) => {
      if (cancelled) return;
      lastShown.current = parseSnapshot(raw);
      setHydrated(true);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!hydrated || !ready) return;
    const prev = lastShown.current;
    const { bursts, next } = diffCheckpointReached(prev, goals);
    lastShown.current = next;
    if (JSON.stringify(prev) !== JSON.stringify(next)) {
      AsyncStorage.setItem(CHECKPOINT_SNAPSHOT_KEY, JSON.stringify(next)).catch(() => {});
    }
    if (bursts.length === 0) return;

    const labels = bursts.map((burst) => burst.label);
    setState((s) => ({ key: s.queue.length === 0 ? s.key + 1 : s.key, queue: [...s.queue, ...labels] }));
  }, [goals, hydrated, ready]);

  const onDone = useCallback(() => {
    setState((s) => {
      const queue = s.queue.slice(1);
      return { key: queue.length > 0 ? s.key + 1 : s.key, queue };
    });
  }, []);

  return { celebrationKey: state.key, label: state.queue[0] ?? null, onDone };
}
