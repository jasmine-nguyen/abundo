// WHIT-747 QA — the celebration hook's saved copy when the phone's storage misbehaves: a failed
// read, a saved value that isn't an object, a failed write, no rewrite when nothing changed, and a
// step with no matching label. Real hook + real diff + the in-memory AsyncStorage stand-in.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCheckpointCelebration, CheckpointCount } from '../hooks/useCheckpointCelebration';
import { CHECKPOINT_SNAPSHOT_KEY } from '../checkpointCelebration';

const HOLIDAY = ['Holiday · $2,000 reached', 'Holiday · $5,000 reached', 'Holiday · goal reached'];
const holiday = (reached: number | null): CheckpointCount[] => [{ id: 'g1', reached, labels: HOLIDAY }];
const saved = async () => JSON.parse((await AsyncStorage.getItem(CHECKPOINT_SNAPSHOT_KEY)) ?? 'null');

function renderReady(initial: CheckpointCount[]) {
  return renderHook(({ c }: { c: CheckpointCount[] }) => useCheckpointCelebration(c, true), { initialProps: { c: initial } });
}

beforeEach(async () => {
  await AsyncStorage.clear();
});
afterEach(() => { jest.restoreAllMocks(); });

describe('useCheckpointCelebration saved copy (WHIT-747 QA)', () => {
  // [A12]
  it('a failed storage read counts as no saved copy: seeds silently, then still celebrates later crossings', async () => {
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('disk'));
    const { result, rerender } = renderReady(holiday(1));
    await waitFor(async () => expect(await saved()).toEqual({ g1: 1 }));
    expect(result.current.celebrationKey).toBe(0);

    rerender({ c: holiday(2) });
    await waitFor(() => expect(result.current.celebrationKey).toBe(1));
  });

  // [A13]
  it('a saved value of JSON null counts as no saved copy (no crash)', async () => {
    await AsyncStorage.setItem(CHECKPOINT_SNAPSHOT_KEY, 'null');
    const { result } = renderReady(holiday(2));
    await waitFor(async () => expect(await saved()).toEqual({ g1: 2 }));
    expect(result.current.celebrationKey).toBe(0);
  });

  // [A14]
  it('does not rewrite the saved copy when nothing changed', async () => {
    await AsyncStorage.setItem(CHECKPOINT_SNAPSHOT_KEY, JSON.stringify({ g1: 1 }));
    const setItem = jest.spyOn(AsyncStorage, 'setItem');
    const { result, rerender } = renderReady(holiday(1));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); // the saved copy loads
    rerender({ c: holiday(1) });
    rerender({ c: holiday(null) }); // balance briefly unknown: the count is carried, not rewritten
    rerender({ c: holiday(2) });    // a real change, to prove the comparisons above really ran
    await waitFor(() => expect(result.current.celebrationKey).toBe(1));
    expect(setItem.mock.calls).toEqual([[CHECKPOINT_SNAPSHOT_KEY, JSON.stringify({ g1: 2 })]]);
  });

  // [A15]
  it('a failed storage write still celebrates (the banner never depends on the save)', async () => {
    await AsyncStorage.setItem(CHECKPOINT_SNAPSHOT_KEY, JSON.stringify({ g1: 1 }));
    jest.spyOn(AsyncStorage, 'setItem').mockRejectedValue(new Error('disk full'));
    const { result } = renderReady(holiday(2));
    await waitFor(() => expect(result.current.celebrationKey).toBe(1));
    expect(result.current.label).toBe('Holiday · $5,000 reached');
  });

  // [A21]
  it('a step with no matching label still celebrates, with the generic banner', async () => {
    await AsyncStorage.setItem(CHECKPOINT_SNAPSHOT_KEY, JSON.stringify({ mortgage: 0 }));
    const { result } = renderReady([{ id: 'mortgage', reached: 1, labels: [] }]);
    await waitFor(() => expect(result.current.celebrationKey).toBe(1));
    expect(result.current.label).toBeNull();
  });
});
