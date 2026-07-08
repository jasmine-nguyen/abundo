// WHIT-199 — the bottom-sheet open spring. Mirrors applyVisibility (NavBarsContext): a pure
// helper so the reduce-motion gate is directly unit-testable without a mounted Modal.
import { Animated } from 'react-native';

// The distance (px) the sheet rises from as it springs into place on open. A moderate pop,
// not a full-height slide — combined with the Modal's fade it reads as a native spring.
export const SHEET_ENTER_OFFSET = 64;

// Spring the sheet's translateY to its resting position (0) on open. reduce-motion → jump
// instantly with setValue (no spring frames), exactly like applyVisibility. The value must
// be seeded at SHEET_ENTER_OFFSET before calling this so the spring has somewhere to rise from.
export function springSheetIn(translateY: Animated.Value, reduceMotion: boolean): void {
  if (reduceMotion) {
    translateY.setValue(0);
    return;
  }
  Animated.spring(translateY, {
    toValue: 0,
    useNativeDriver: true,
    friction: 12,
    tension: 90,
  }).start();
}
