// WHIT-184 — the chrome motion primitives: the reduce-motion gate (instant vs tween)
// and the safe no-provider default (bare screens must render without a ChromeProvider).
import { describe, it, expect, jest, afterEach } from '@jest/globals';
import React from 'react';
import { Animated, Text } from 'react-native';
import { render } from '@testing-library/react-native';
import { applyVisibility, useChrome, ChromeProvider } from '../motion/ChromeContext';

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

describe('ChromeContext default (no provider)', () => {
  function Probe() {
    const { visibility, setChrome } = useChrome();
    // Calling the default no-op setter must not throw, and visibility must be a real
    // Animated.Value (interpolatable) so a bare screen's header style still builds.
    setChrome('hidden');
    const t = typeof visibility.interpolate;
    return <Text testID="probe">{t}</Text>;
  }

  it('renders a consumer with NO ChromeProvider without crashing', () => {
    const { getByTestId } = render(<Probe />);
    expect(getByTestId('probe').props.children).toBe('function');
  });

  it('renders a consumer UNDER a ChromeProvider without crashing', () => {
    const { getByTestId } = render(
      <ChromeProvider reduceMotion={false}><Probe /></ChromeProvider>,
    );
    expect(getByTestId('probe').props.children).toBe('function');
  });
});
