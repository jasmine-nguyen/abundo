// WHIT-811: read and write the celebration's saved copy on the phone (the in-memory AsyncStorage stand-in).
import AsyncStorage from '@react-native-async-storage/async-storage';
import { CHECKPOINT_SNAPSHOT_KEY } from '../../checkpointCelebration';
import { REPAYMENT_SEEN_KEY } from '../../repaymentLanded';

export const savedCelebrationSnapshot = async () =>
  JSON.parse((await AsyncStorage.getItem(CHECKPOINT_SNAPSHOT_KEY)) ?? 'null');

// What an earlier launch of the app saved (any shape, so old count-style copies too).
export const savedFromEarlierLaunch = (snapshot: unknown) =>
  AsyncStorage.setItem(CHECKPOINT_SNAPSHOT_KEY, JSON.stringify(snapshot));

// WHIT-820: the "last repayment this phone has shown" note.
export const savedRepaymentNote = () => AsyncStorage.getItem(REPAYMENT_SEEN_KEY);

export const repaymentSeenEarlier = (note: string) => AsyncStorage.setItem(REPAYMENT_SEEN_KEY, note);
