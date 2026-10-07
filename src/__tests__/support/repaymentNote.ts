// WHIT-820: read and write the "last repayment this phone has shown" note (the in-memory AsyncStorage
// stand-in). (Not a *.test file, so Jest never runs it as a suite.)
import AsyncStorage from '@react-native-async-storage/async-storage';
import { REPAYMENT_SEEN_KEY } from '../../repaymentLanded';

export const savedRepaymentNote = () => AsyncStorage.getItem(REPAYMENT_SEEN_KEY);

export const repaymentSeenEarlier = (note: string) => AsyncStorage.setItem(REPAYMENT_SEEN_KEY, note);
