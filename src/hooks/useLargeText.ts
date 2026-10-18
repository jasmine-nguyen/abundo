import { useWindowDimensions } from 'react-native';

// Between iOS XXXL (1.35) and the first accessibility size AX1 (~1.65): from here, layouts stack instead of squeezing (WHIT-743).
const LARGE_TEXT_SCALE = 1.5;
// Row text stops growing at about 2× so a long single word never has to split mid-word (WHIT-743).
export const LARGE_TEXT_MAX_SCALE = 2;
// The screen header's title and the line under it (WHIT-863). The title sits in HEADER_BODY_HEIGHT
// minus 18px of padding (40px); 19px × 1.5 still fits, so it can't grow over the first card.
export const TITLE_MAX_SCALE = 1.5;
// Big hero numbers grow with the user's text size up to the same cap, so they stay one size (WHIT-741).
export const HERO_BIG_MAX_SCALE = 1.4;

export function useLargeText() {
  return useWindowDimensions().fontScale >= LARGE_TEXT_SCALE;
}
