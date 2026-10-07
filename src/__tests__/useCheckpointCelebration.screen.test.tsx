// WHIT-481 / WHIT-747 / WHIT-811 — the hook that drives the confetti. The logic tests lock the pure
// diff; these lock what only the HOOK adds on top of it: the snapshot saved on the phone (a crossing
// since the last saved copy bursts on mount; no saved copy seeds silently; nothing is compared or
// saved until the caller is ready), that a new array IDENTITY with unchanged steps does NOT re-burst,
// and the queue: several bursts show one after another as the banner calls onDone.
// Uses the real hook + real diff + the in-memory AsyncStorage stand-in.
import { describe, it, expect, beforeEach } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCheckpointCelebration } from '../hooks/useCheckpointCelebration';
import { CHECKPOINT_SNAPSHOT_KEY, GoalSteps, StepSnapshot } from '../checkpointCelebration';
import { goalSteps, stepSnapshot } from './support/celebrationSteps';
import { savedCelebrationSnapshot as saved } from './support/celebrationSnapshot';

// Render the hook and wait until the saved snapshot has loaded and the first comparison has saved.
async function renderLoaded(initial: GoalSteps[], expectedSave: StepSnapshot) {
  const view = renderHook(({ c, ready }: { c: GoalSteps[]; ready: boolean }) => useCheckpointCelebration(c, ready), {
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
    await AsyncStorage.setItem(CHECKPOINT_SNAPSHOT_KEY, JSON.stringify(stepSnapshot({ g1: [true, false] })));
    const { result } = renderHook(() => useCheckpointCelebration([goalSteps('g1', [true, true])], true));
    await waitFor(() => expect(result.current.celebrationKey).toBe(1));
    expect(result.current.label).toBe('g1 step 1');
    expect(await saved()).toEqual(stepSnapshot({ g1: [true, true] }));
  });

  it('with no saved copy (a brand-new install) seeds silently and saves the steps', async () => {
    const { result } = await renderLoaded([goalSteps('g1', [true, true])], stepSnapshot({ g1: [true, true] }));
    expect(result.current.celebrationKey).toBe(0);
    expect(result.current.label).toBeNull();
  });

  it('neither compares nor saves while the caller is not ready, then catches up once it is', async () => {
    const before = stepSnapshot({ g1: [true, false] });
    await AsyncStorage.setItem(CHECKPOINT_SNAPSHOT_KEY, JSON.stringify(before));
    const { result, rerender } = renderHook(
      ({ c, ready }: { c: GoalSteps[]; ready: boolean }) => useCheckpointCelebration(c, ready),
      { initialProps: { c: [] as GoalSteps[], ready: false } },
    );
    rerender({ c: [], ready: false }); // an empty first paint must not wipe the saved copy
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await saved()).toEqual(before);
    expect(result.current.celebrationKey).toBe(0);

    rerender({ c: [goalSteps('g1', [true, true])], ready: true });
    await waitFor(() => expect(result.current.celebrationKey).toBe(1));
    expect(await saved()).toEqual(stepSnapshot({ g1: [true, true] }));
  });

  it('treats an unreadable saved copy as none', async () => {
    await AsyncStorage.setItem(CHECKPOINT_SNAPSHOT_KEY, 'not json');
    const { result } = await renderLoaded([goalSteps('g1', [true])], stepSnapshot({ g1: [true] }));
    expect(result.current.celebrationKey).toBe(0);
  });

  it('does NOT re-burst when the array is a new identity but every step is unchanged', async () => {
    const { result, rerender } = await renderLoaded([goalSteps('g1', [true])], stepSnapshot({ g1: [true] }));
    rerender({ c: [goalSteps('g1', [true])], ready: true });
    rerender({ c: [goalSteps('g1', [true])], ready: true });
    expect(result.current.celebrationKey).toBe(0);
    expect(result.current.label).toBeNull();
  });

  it('queues bursts: shows each in turn as the banner finishes, then clears', async () => {
    const { result, rerender } = await renderLoaded(
      [goalSteps('g1', [false]), goalSteps('g2', [false])],
      stepSnapshot({ g1: [false], g2: [false] }),
    );
    rerender({ c: [goalSteps('g1', [true]), goalSteps('g2', [true])], ready: true });
    expect(result.current).toMatchObject({ celebrationKey: 1, label: 'g1 step 0' });

    act(() => result.current.onDone());
    expect(result.current).toMatchObject({ celebrationKey: 2, label: 'g2 step 0' });

    act(() => result.current.onDone());
    expect(result.current).toMatchObject({ celebrationKey: 2, label: null });
  });
});
