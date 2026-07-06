// WHIT-184/200 — the nav-bars motion primitives: the reduce-motion gate (instant vs
// tween) and the safe no-provider default (bare screens must render without a
// NavBarsProvider). Also guards that the provider stays navigation-free — it renders
// bare here with no router, which is why the route reset lives in NavBarsRouteReset.
import { describe, it, expect, jest, afterEach } from '@jest/globals';
import React from 'react';
import { Animated, Text } from 'react-native';
import { render } from '@testing-library/react-native';
import { applyVisibility, useNavBars, NavBarsProvider } from '../motion/NavBarsContext';

afterEach(() => { jest.restoreAllMocks(); });

describe('applyVisibility (reduce-motion gate)', () => {
  it('reduce-motion ON snaps instantly with setValue — no timing animation', () => {
    const value = new Animated.Value(1);
    const timing = jest.spyOn(Animated, 'timing');
    applyVisibility(value, 0, true);
    // Jumped straight to the target, and no animation was scheduled.
    expect((value as unknown as { __getValue(): number }).__getValue()).toBe(0);
    expect(timing).not.toHaveBeenCalled();
  });

  it('reduce-motion OFF animates via Animated.timing on the native driver', () => {
    const value = new Animated.Value(1);
    const start = jest.fn();
    const timing = jest.spyOn(Animated, 'timing').mockReturnValue({ start } as unknown as Animated.CompositeAnimation);
    applyVisibility(value, 0, false);
    expect(timing).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect((timing.mock.calls[0][1] as { useNativeDriver: boolean }).useNativeDriver).toBe(true);
  });
});

describe('NavBarsContext default (no provider)', () => {
  function Probe() {
    const { visibility, setNavBars, stateRef } = useNavBars();
    // Calling the setter must not throw (a no-op under the default, a real setter under a
    // provider); visibility must be a real Animated.Value (interpolatable) so a bare
    // screen's header style still builds; and stateRef must exist (the scroll hook reads it).
    setNavBars('hidden');
    const ok = typeof visibility.interpolate === 'function' && stateRef != null && 'current' in stateRef;
    return <Text testID="probe">{String(ok)}</Text>;
  }

  it('renders a consumer with NO NavBarsProvider without crashing', () => {
    const { getByTestId } = render(<Probe />);
    expect(getByTestId('probe').props.children).toBe('true');
  });

  it('renders a consumer UNDER a NavBarsProvider without crashing', () => {
    const { getByTestId } = render(
      <NavBarsProvider reduceMotion={false}><Probe /></NavBarsProvider>,
    );
    expect(getByTestId('probe').props.children).toBe('true');
  });
});
