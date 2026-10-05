// WHIT-481 / WHIT-747 — the hook that drives the confetti. The logic tests lock the pure diff; these
// lock what only the HOOK adds on top of it: the snapshot saved on the phone (a crossing since the
// last saved copy bursts on mount; no saved copy seeds silently; nothing is compared or saved until
// the caller is ready), which step the burst is LABELLED off, that a new counts-array IDENTITY with
// unchanged counts does NOT re-burst, and that celebrationKey only advances on a genuine tick-up.
// Uses the real hook + real diff + the in-memory AsyncStorage stand-in.
import { describe, it, expect, beforeEach } from '@jest/globals';
import { renderHook, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCheckpointCelebration, CheckpointCount } from '../hooks/useCheckpointCelebration';
import { CHECKPOINT_SNAPSHOT_KEY } from '../checkpointCelebration';

const HOLIDAY = ['Holiday · $2,000 reached', 'Holiday · $5,000 reached', 'Holiday · goal reached'];
const WEDDING = ['Wedding · $1,000 reached', 'Wedding · $3,000 reached', 'Wedding · goal reached'];

// Build a fresh counts ARRAY each call so identity always differs — the caller memoises, but the
// hook must not lean on identity for correctness, only for skipping the effect.
const counts = (...cs: CheckpointCount[]): CheckpointCount[] => cs.map((c) => ({ ...c }));
const holiday = (reached: number | null): CheckpointCount => ({ id: 'g1', reached, labels: HOLIDAY });
const wedding = (reached: number | null): CheckpointCount => ({ id: 'g2', reached, labels: WEDDING });

const saved = async () => JSON.parse((await AsyncStorage.getItem(CHECKPOINT_SNAPSHOT_KEY)) ?? 'null');

// Render the hook and wait until the saved snapshot has loaded and the first comparison has saved.
async function renderLoaded(initial: CheckpointCount[], expectedSave: Record<string, number>) {
  const view = renderHook(({ c, ready }: { c: CheckpointCount[]; ready: boolean }) => useCheckpointCelebration(c, ready), {
    initialProps: { c: initial, ready: true },
  });
  await waitFor(async () => expect(await saved()).toEqual(expectedSave));
  return view;
}

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('useCheckpointCelebration', () => {
  it('celebrates on mount a step crossed since the copy saved by an earlier launch', async () => {
    await AsyncStorage.setItem(CHECKPOINT_SNAPSHOT_KEY, JSON.stringify({ g1: 1 }));
    const { result } = renderHook(() => useCheckpointCelebration(counts(holiday(2)), true));
    await waitFor(() => expect(result.current.celebrationKey).toBe(1));
    expect(result.current.label).toBe('Holiday · $5,000 reached');
    expect(await saved()).toEqual({ g1: 2 });
  });

  it('with no saved copy (a brand-new install) seeds silently and saves the counts', async () => {
    const { result } = await renderLoaded(counts(holiday(2)), { g1: 2 });
    expect(result.current.celebrationKey).toBe(0);
    expect(result.current.label).toBeNull();
  });

  it('neither compares nor saves while the caller is not ready, then catches up once it is', async () => {
    await AsyncStorage.setItem(CHECKPOINT_SNAPSHOT_KEY, JSON.stringify({ g1: 1 }));
    const { result, rerender } = renderHook(
      ({ c, ready }: { c: CheckpointCount[]; ready: boolean }) => useCheckpointCelebration(c, ready),
      { initialProps: { c: counts(), ready: false } },
    );
    rerender({ c: counts(), ready: false }); // an empty first paint must not wipe the saved copy
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await saved()).toEqual({ g1: 1 });
    expect(result.current.celebrationKey).toBe(0);

    rerender({ c: counts(holiday(2)), ready: true });
    await waitFor(() => expect(result.current.celebrationKey).toBe(1));
    expect(await saved()).toEqual({ g1: 2 });
  });

  it('treats an unreadable saved copy as none', async () => {
    await AsyncStorage.setItem(CHECKPOINT_SNAPSHOT_KEY, 'not json');
    const { result } = await renderLoaded(counts(holiday(2)), { g1: 2 });
    expect(result.current.celebrationKey).toBe(0);
  });

  it('labels the burst off the highest step just reached', async () => {
    const { result, rerender } = await renderLoaded(counts(holiday(0)), { g1: 0 });
    rerender({ c: counts(holiday(3)), ready: true }); // jumped both checkpoints AND the target
    expect(result.current.celebrationKey).toBe(1);
    expect(result.current.label).toBe('Holiday · goal reached');
  });

  it('labels off the FIRST bursting goal in array order when several tick up together', async () => {
    const { result, rerender } = await renderLoaded(counts(holiday(0), wedding(1)), { g1: 0, g2: 1 });
    rerender({ c: counts(holiday(1), wedding(2)), ready: true });
    expect(result.current.celebrationKey).toBe(1);
    expect(result.current.label).toBe('Holiday · $2,000 reached');
  });

  it('labels off the goal that actually ticked, not the first goal in the array', async () => {
    const { result, rerender } = await renderLoaded(counts(holiday(2), wedding(1)), { g1: 2, g2: 1 });
    rerender({ c: counts(holiday(2), wedding(2)), ready: true });
    expect(result.current.celebrationKey).toBe(1);
    expect(result.current.label).toBe('Wedding · $3,000 reached');
  });

  it('does NOT re-burst when the counts array is a new identity but every count is unchanged', async () => {
    const { result, rerender } = await renderLoaded(counts(holiday(1)), { g1: 1 });
    rerender({ c: counts(holiday(1)), ready: true });
    rerender({ c: counts(holiday(1)), ready: true });
    expect(result.current.celebrationKey).toBe(0);
    expect(result.current.label).toBeNull();
  });

  it('does not label off a brand-new goal seen for the first time even as another ticks up', async () => {
    const { result, rerender } = await renderLoaded(counts(holiday(1)), { g1: 1 });
    rerender({ c: counts(holiday(2), wedding(2)), ready: true });
    expect(result.current.celebrationKey).toBe(1);
    expect(result.current.label).toBe('Holiday · $5,000 reached');
  });

  it('advances the key once per genuine tick-up across successive refreshes', async () => {
    const { result, rerender } = await renderLoaded(counts(holiday(0)), { g1: 0 });
    rerender({ c: counts(holiday(1)), ready: true });
    expect(result.current.celebrationKey).toBe(1);
    rerender({ c: counts(holiday(2)), ready: true });
    expect(result.current.celebrationKey).toBe(2);
    expect(result.current.label).toBe('Holiday · $5,000 reached');
  });
});
