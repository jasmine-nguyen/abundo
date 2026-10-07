// WHIT-811: read and write the celebration's saved copy on the phone (the in-memory AsyncStorage stand-in),
// and render the celebration hook against it.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { renderHook } from '@testing-library/react-native';
import { CHECKPOINT_SNAPSHOT_KEY, GoalSteps } from '../../checkpointCelebration';
import { useCheckpointCelebration } from '../../hooks/useCheckpointCelebration';
import { REPAYMENT_SEEN_KEY } from '../../repaymentLanded';

export const savedCelebrationSnapshot = async () =>
  JSON.parse((await AsyncStorage.getItem(CHECKPOINT_SNAPSHOT_KEY)) ?? 'null');

// What an earlier launch of the app saved (any shape, so old count-style copies too).
export const savedFromEarlierLaunch = (snapshot: unknown) =>
  AsyncStorage.setItem(CHECKPOINT_SNAPSHOT_KEY, JSON.stringify(snapshot));

// WHIT-820: the "last repayment this phone has shown" note.
export const savedRepaymentNote = () => AsyncStorage.getItem(REPAYMENT_SEEN_KEY);

export const repaymentSeenEarlier = (note: string) => AsyncStorage.setItem(REPAYMENT_SEEN_KEY, note);

// The celebration hook, ready from the start, rerenderable with new steps as `{ c }`.
export function renderCelebrationHook(initial: GoalSteps[]) {
  return renderHook(({ c }: { c: GoalSteps[] }) => useCheckpointCelebration(c, true), { initialProps: { c: initial } });
}
