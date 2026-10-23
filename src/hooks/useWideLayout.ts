import { Platform, useWindowDimensions } from 'react-native';

// Normal iPhones are locked upright, so at most 440pt wide; the iPhone Duo's inner screen is at least 626pt in either orientation (ABU-110, ABU-118).
export const WIDE_MIN_WIDTH = 600;

// The web build frames the app phone-sized, so it never goes wide.
export function useWideLayout() {
  const { width } = useWindowDimensions();
  if (Platform.OS === 'web') return false;
  return width >= WIDE_MIN_WIDTH;
}
