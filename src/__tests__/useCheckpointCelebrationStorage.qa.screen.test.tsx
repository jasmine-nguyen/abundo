// WHIT-747 QA — the celebration hook's saved copy when the phone's storage misbehaves: a failed
// read, a saved value that isn't an object, a failed write, and no rewrite when nothing changed.
// Real hook + real diff + the in-memory AsyncStorage stand-in.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCheckpointCelebration } from '../hooks/useCheckpointCelebration';
import { CHECKPOINT_SNAPSHOT_KEY, GoalSteps } from '../checkpointCelebration';
import { goalSteps, stepSnapshot } from './support/celebrationSteps';
import { savedCelebrationSnapshot as saved } from './support/celebrationSnapshot';

const holiday = (reached: boolean[] | null): GoalSteps[] => [goalSteps('g1', reached)];
const ONE_REACHED = stepSnapshot({ g1: [true, false] });
const BOTH_REACHED = stepSnapshot({ g1: [true, true] });

function renderReady(initial: GoalSteps[]) {
  return renderHook(({ c }: { c: GoalSteps[] }) => useCheckpointCelebration(c, true), { initialProps: { c: initial } });
}

beforeEach(async () => {
  await AsyncStorage.clear();
});
afterEach(() => { jest.restoreAllMocks(); });

describe('useCheckpointCelebration saved copy (WHIT-747 QA)', () => {
  // [A12]
  it('a failed storage read counts as no saved copy: seeds silently, then still celebrates later crossings', async () => {
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('disk'));
    const { result, rerender } = renderReady(holiday([true, false]));
    await waitFor(async () => expect(await saved()).toEqual(ONE_REACHED));
    expect(result.current.celebrationKey).toBe(0);

    rerender({ c: holiday([true, true]) });
    await waitFor(() => expect(result.current.celebrationKey).toBe(1));
  });

  // [A13]
  it('a saved value of JSON null counts as no saved copy (no crash)', async () => {
    await AsyncStorage.setItem(CHECKPOINT_SNAPSHOT_KEY, 'null');
    const { result } = renderReady(holiday([true, true]));
    await waitFor(async () => expect(await saved()).toEqual(BOTH_REACHED));
    expect(result.current.celebrationKey).toBe(0);
  });

  // [A14]
  it('does not rewrite the saved copy when nothing changed', async () => {
    await AsyncStorage.setItem(CHECKPOINT_SNAPSHOT_KEY, JSON.stringify(ONE_REACHED));
    const setItem = jest.spyOn(AsyncStorage, 'setItem');
    const { result, rerender } = renderReady(holiday([true, false]));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); // the saved copy loads
    rerender({ c: holiday([true, false]) });
    rerender({ c: holiday(null) });          // balance briefly unknown: the last look is carried, not rewritten
    rerender({ c: holiday([true, true]) });  // a real change, to prove the comparisons above really ran
    await waitFor(() => expect(result.current.celebrationKey).toBe(1));
    expect(setItem.mock.calls).toEqual([[CHECKPOINT_SNAPSHOT_KEY, JSON.stringify(BOTH_REACHED)]]);
  });

  // [A15]
  it('a failed storage write still celebrates (the banner never depends on the save)', async () => {
    await AsyncStorage.setItem(CHECKPOINT_SNAPSHOT_KEY, JSON.stringify(ONE_REACHED));
    jest.spyOn(AsyncStorage, 'setItem').mockRejectedValue(new Error('disk full'));
    const { result } = renderReady(holiday([true, true]));
    await waitFor(() => expect(result.current.celebrationKey).toBe(1));
    expect(result.current.label).toBe('g1 step 1');
  });
});
