// WHIT-200 GAP — the provider's OWN dedup guard: NavBarsProvider.setNavBars short-circuits
// when the requested state equals the current stateRef (NavBarsContext.tsx:63), so an
// in-flight show/hide tween isn't restarted by a redundant call. The implementer's
// navBarsContext test covers applyVisibility (the reduce-motion gate) directly and
// useScrollNavBars covers the HOOK-level dedup against the mocked setter — neither exercises
// the provider's real setNavBars branch. Reduce-motion is OFF so the guard is observed via
// whether Animated.timing is (re)started.
//
// Fail-on-revert: delete the `if (next === stateRef.current) return;` line and the
// "same-state is a no-op" assertions flip (timing fires when it shouldn't).
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { Animated } from 'react-native';
import { render, act } from '@testing-library/react-native';
import { NavBarsProvider, useNavBars } from '../motion/NavBarsContext';

let captured: ReturnType<typeof useNavBars>;
function Probe() { captured = useNavBars(); return null; }

let timing: ReturnType<typeof jest.spyOn>;
const start = jest.fn();

beforeEach(() => {
  start.mockClear();
  // Stub Animated.timing so no real frames run; we only care that it's (re)started or not.
  timing = jest.spyOn(Animated, 'timing').mockReturnValue({ start } as unknown as Animated.CompositeAnimation);
  render(<NavBarsProvider reduceMotion={false}><Probe /></NavBarsProvider>);
});
afterEach(() => { jest.restoreAllMocks(); });

it('setNavBars to the CURRENT state is a no-op (does not start a tween)', () => {
  // Provider starts 'shown'; asking for 'shown' again must not animate.
  act(() => captured.setNavBars('shown'));
  expect(timing).not.toHaveBeenCalled();
});

it('a real transition animates once; a redundant repeat does not re-animate', () => {
  act(() => captured.setNavBars('hidden'));   // shown -> hidden: one tween
  expect(timing).toHaveBeenCalledTimes(1);
  expect(start).toHaveBeenCalledTimes(1);

  act(() => captured.setNavBars('hidden'));   // already hidden: guarded, no new tween
  expect(timing).toHaveBeenCalledTimes(1);

  act(() => captured.setNavBars('shown'));    // hidden -> shown: a new tween
  expect(timing).toHaveBeenCalledTimes(2);
});
