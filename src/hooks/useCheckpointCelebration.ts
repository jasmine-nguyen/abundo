// WHIT-481 — holds the Goals screen's "last shown" step counts and drives the confetti.
//
// WHIT-747: the snapshot is saved on the phone (AsyncStorage), so a crossing made while the app was
// closed celebrates on the next open. It's loaded once on mount; nothing is compared until it has
// loaded AND the caller says its data is `ready` (loaded, and the screen in focus) — otherwise an
// empty first paint would overwrite the saved copy. With no saved copy (a brand-new install) the
// first comparison still seeds every goal silently. The working copy lives in a ref, not state, so
// comparing never causes a redraw. `counts` must be memoised by the caller so a plain redraw (same
// identity) doesn't re-run the effect; a real balance change gives it a new identity and re-runs it.
import { useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { CHECKPOINT_SNAPSHOT_KEY, diffCheckpointReached, ReachedSnapshot } from '../checkpointCelebration';

export interface CheckpointCount {
  id: string;
  reached: number | null;
  // What the banner says for each step, in order: labels[n - 1] names the n-th step reached.
  labels: string[];
}

export interface CheckpointCelebration {
  // A counter that increments on each new burst; the overlay re-fires when it changes.
  celebrationKey: number;
  // Names the highest step the bursting goal just reached, for the banner.
  label: string | null;
}

function parseSnapshot(raw: string | null): ReachedSnapshot {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function sameSnapshot(a: ReachedSnapshot, b: ReachedSnapshot): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

export function useCheckpointCelebration(counts: CheckpointCount[], ready: boolean): CheckpointCelebration {
  const lastShown = useRef<ReachedSnapshot>({});
  const [hydrated, setHydrated] = useState(false);
  const [state, setState] = useState({ key: 0, label: null as string | null });

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
    const { bursts, next } = diffCheckpointReached(
      prev,
      counts.map((c) => ({ id: c.id, reached: c.reached })),
    );
    lastShown.current = next;
    if (!sameSnapshot(prev, next)) {
      AsyncStorage.setItem(CHECKPOINT_SNAPSHOT_KEY, JSON.stringify(next)).catch(() => {});
    }
    if (bursts.length === 0) return;

    // One burst per refresh, even if several goals ticked up — labelled off the first.
    const first = bursts[0];
    const label = counts.find((c) => c.id === first.goalId)?.labels[first.reached - 1] ?? null;
    setState((s) => ({ key: s.key + 1, label }));
  }, [counts, hydrated, ready]);

  return { celebrationKey: state.key, label: state.label };
}
