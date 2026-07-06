// WHIT-184/200 — the scroll-direction → nav-bars state machine. This is the fail-on-revert
// gate for scroll-to-hide: break the direction rule and a row here flips. Pure, so it
// runs in the fast node `logic` project.
import { describe, it, expect } from '@jest/globals';
import { nextNavBarsState, TOP_ZONE, DIRECTION_THRESHOLD } from '../motion/navBarsVisibility';

describe('nextNavBarsState', () => {
  it('hides when scrolling down past the threshold', () => {
    expect(nextNavBarsState('shown', { y: 200, prevY: 150 })).toBe('hidden');
  });

  it('shows again when scrolling up past the threshold', () => {
    expect(nextNavBarsState('hidden', { y: 150, prevY: 200 })).toBe('shown');
  });

  it('always shows at/near the top, even mid downward gesture', () => {
    // y within the top zone wins over a downward delta (prevY below it).
    expect(nextNavBarsState('hidden', { y: TOP_ZONE, prevY: TOP_ZONE + 100 })).toBe('shown');
    expect(nextNavBarsState('hidden', { y: 0, prevY: 40 })).toBe('shown');
  });

  it('ignores sub-threshold jitter (keeps the previous state)', () => {
    const belowThreshold = DIRECTION_THRESHOLD - 1;
    expect(nextNavBarsState('hidden', { y: 100 + belowThreshold, prevY: 100 })).toBe('hidden');
    expect(nextNavBarsState('shown', { y: 100 + belowThreshold, prevY: 100 })).toBe('shown');
    // a tiny upward wobble also doesn't flip a hidden bar back
    expect(nextNavBarsState('hidden', { y: 100, prevY: 100 + belowThreshold })).toBe('hidden');
  });

  it('does not hide from a downward move while still inside the top zone', () => {
    // Scrolling down but ending at y <= TOP_ZONE stays shown (no early flicker on lift-off).
    expect(nextNavBarsState('shown', { y: TOP_ZONE, prevY: 0 })).toBe('shown');
  });

  it('respects a custom threshold', () => {
    // delta of 10 hides at the default (4) but not at a threshold of 20.
    expect(nextNavBarsState('shown', { y: 110, prevY: 100 }, 20)).toBe('shown');
    expect(nextNavBarsState('shown', { y: 130, prevY: 100 }, 20)).toBe('hidden');
  });
});
