// WHIT-811 QA — the celebration hook's queue when a burst lands while a banner is already showing. Real hook + real diff + the in-memory AsyncStorage stand-in.
import { describe, it, expect, beforeEach } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCheckpointCelebration } from '../hooks/useCheckpointCelebration';
import { GoalSteps } from '../checkpointCelebration';
import { goalSteps, stepSnapshot } from './support/celebrationSteps';
import { savedCelebrationSnapshot as saved } from './support/celebrationSnapshot';

function renderReady(initial: GoalSteps[]) {
  return renderHook(({ c }: { c: GoalSteps[] }) => useCheckpointCelebration(c, true), { initialProps: { c: initial } });
}

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('useCheckpointCelebration queue and switch-over (WHIT-811 QA)', () => {
  // [A4]
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
});
