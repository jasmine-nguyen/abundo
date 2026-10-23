import { Platform, useWindowDimensions } from 'react-native';

// Every iPhone in portrait is at most 440pt wide; the iPhone Duo's inner screen is at least 626pt (ABU-110).
export const WIDE_MIN_WIDTH = 600;

// The web build frames the app phone-sized, so it never goes wide.
export function useWideLayout() {
  const { width } = useWindowDimensions();
  if (Platform.OS === 'web') return false;
  return width >= WIDE_MIN_WIDTH;
}
