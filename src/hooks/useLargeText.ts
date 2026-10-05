import { useWindowDimensions } from 'react-native';

// Between iOS XXXL (1.35) and the first accessibility size AX1 (~1.65): from here, layouts stack instead of squeezing (WHIT-743).
export const LARGE_TEXT_SCALE = 1.5;
// Row text stops growing at about 2× so a long single word never has to split mid-word (WHIT-743).
export const LARGE_TEXT_MAX_SCALE = 2;

export function useLargeText() {
  return useWindowDimensions().fontScale >= LARGE_TEXT_SCALE;
}
