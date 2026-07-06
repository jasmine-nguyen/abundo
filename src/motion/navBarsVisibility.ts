// WHIT-184/200 — the pure scroll-direction → nav-bars-visibility state machine. "Nav
// bars" = the app's chrome: the top header + the bottom tab bar, which hide together on
// scroll. No React, no react-native imports, so it runs in the fast `logic` jest project
// and is the fail-on-revert gate for scroll-to-hide. The impure parts (the shared
// Animated.Value, the scroll wiring) live in NavBarsContext / useScrollNavBars.

export type NavBarsState = 'shown' | 'hidden';

// Within this many px of the top, the bars are ALWAYS shown — so a short list, a bounce,
// or settling back at the top never strands the header/tab bar hidden.
export const TOP_ZONE = 8;
// Ignore direction changes smaller than this (px since the last scroll event) so
// sub-pixel jitter / momentum wobble doesn't flip the bars back and forth.
export const DIRECTION_THRESHOLD = 4;

// Given the previous state and the latest scroll sample, decide the next state.
// - at/near the top -> shown (wins over everything)
// - scrolling down past the threshold -> hidden (immersive reading)
// - scrolling up past the threshold -> shown
// - otherwise (jitter / no meaningful move) -> unchanged
export function nextNavBarsState(
  prev: NavBarsState,
  sample: { y: number; prevY: number },
  threshold: number = DIRECTION_THRESHOLD,
): NavBarsState {
  const { y, prevY } = sample;
  if (y <= TOP_ZONE) return 'shown';
  const delta = y - prevY;
  if (delta > threshold) return 'hidden';
  if (delta < -threshold) return 'shown';
  return prev;
}
