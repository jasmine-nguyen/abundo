// WHIT-481 / WHIT-747 / WHIT-811 — the hook that drives the confetti. The logic tests lock the pure
// diff; these lock what only the HOOK adds on top of it: the snapshot saved on the phone (a crossing
// since the last saved copy bursts on mount; no saved copy seeds silently; nothing is compared or
// saved until the caller is ready), that a new array IDENTITY with unchanged steps does NOT re-burst,
// the queue: several bursts show one after another as the banner calls onDone, and a failed storage
// read or write never blocks a celebration.
// Uses the real hook + real diff + the in-memory AsyncStorage stand-in.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCheckpointCelebration } from '../hooks/useCheckpointCelebration';
import { CHECKPOINT_SNAPSHOT_KEY, GoalSteps, StepSnapshot } from '../checkpointCelebration';
import { goalSteps, stepSnapshot } from './support/celebrationSteps';
import { renderCelebrationHook as renderReady, savedCelebrationSnapshot as saved } from './support/celebrationSnapshot';

const holiday = (reached: boolean[] | null): GoalSteps[] => [goalSteps('g1', reached)];
const ONE_REACHED = stepSnapshot({ g1: [true, false] });

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
// the failed-write test rejects every setItem; restore it so later tests can save again.
afterEach(() => { jest.restoreAllMocks(); });

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

  it('a burst landing while a banner is showing waits its turn without restarting the current banner', async () => {
    const { result, rerender } = renderReady([goalSteps('g1', [false]), goalSteps('g2', [false])]);
    await waitFor(async () => expect(await saved()).toEqual(stepSnapshot({ g1: [false], g2: [false] })));

    rerender({ c: [goalSteps('g1', [true]), goalSteps('g2', [false])] });
    expect(result.current).toMatchObject({ celebrationKey: 1, label: 'g1 step 0' });

    rerender({ c: [goalSteps('g1', [true]), goalSteps('g2', [true])] }); // a second refresh mid-banner
    expect(result.current).toMatchObject({ celebrationKey: 1, label: 'g1 step 0' });

    act(() => result.current.onDone());
    expect(result.current).toMatchObject({ celebrationKey: 2, label: 'g2 step 0' });

    act(() => result.current.onDone());
    expect(result.current.label).toBeNull();

    rerender({ c: [goalSteps('g1', [false]), goalSteps('g2', [true])] });
    rerender({ c: [goalSteps('g1', [true]), goalSteps('g2', [true])] }); // after the queue empties, a new burst fires a new banner
    expect(result.current).toMatchObject({ celebrationKey: 3, label: 'g1 step 0' });
  });

  it('a failed storage read counts as no saved copy: seeds silently, then still celebrates later crossings', async () => {
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('disk'));
    const { result, rerender } = renderReady(holiday([true, false]));
    await waitFor(async () => expect(await saved()).toEqual(ONE_REACHED));
    expect(result.current.celebrationKey).toBe(0);

    rerender({ c: holiday([true, true]) });
    await waitFor(() => expect(result.current.celebrationKey).toBe(1));
  });

  it('a failed storage write still celebrates (the banner never depends on the save)', async () => {
    await AsyncStorage.setItem(CHECKPOINT_SNAPSHOT_KEY, JSON.stringify(ONE_REACHED));
    jest.spyOn(AsyncStorage, 'setItem').mockRejectedValue(new Error('disk full'));
    const { result } = renderReady(holiday([true, true]));
    await waitFor(() => expect(result.current.celebrationKey).toBe(1));
    expect(result.current.label).toBe('g1 step 1');
  });
});
