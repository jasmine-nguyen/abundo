// WHIT-199 — the bottom-sheet open spring. Mirrors applyVisibility (NavBarsContext): a pure
// helper so the reduce-motion gate is directly unit-testable without a mounted Modal.
import { Animated } from 'react-native';

// The distance (px) the sheet rises from as it springs into place on open. A moderate pop,
// not a full-height slide — combined with the Modal's fade it reads as a native spring.
export const SHEET_ENTER_OFFSET = 64;

// WHIT-290/WHIT-293: the grabber's pull-to-dismiss decision. A release dismisses the sheet when
// EITHER the drag went far enough OR it was a quick downward flick — matching how a real bottom
// sheet feels. Both thresholds are deterministic + unit-testable without a gesture library.
// WHIT-293: distance lowered from 90 (a 90px pull was too much on a short sheet, so pulls sprang
// back and read as "didn't work"); a flick path added so a fast short pull — the natural gesture —
// also dismisses.
export const SHEET_DISMISS_DISTANCE = 56;   // px dragged down
export const SHEET_DISMISS_VELOCITY = 0.5;  // px per ms at release (~500 px/s)

// Whether releasing a grabber-drag should dismiss: `dy` px moved (positive = downward) and `vy`
// the downward velocity (px/ms) at release. Requires a real downward drag (dy > 0) so a plain tap
// (dy ≈ 0) never dismisses; then EITHER a far-enough pull OR a fast flick closes it.
export function shouldDismissSheet(dy: number, vy: number): boolean {
  return dy > 0 && (dy > SHEET_DISMISS_DISTANCE || vy > SHEET_DISMISS_VELOCITY);
}

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
