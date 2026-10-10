// WHIT-184/200 — the nav-bars motion primitives: the reduce-motion gate (instant vs
// tween) and the safe no-provider default (bare screens must render without a
// NavBarsProvider). Also guards that the provider stays navigation-free — it renders
// bare here with no router, which is why the route reset lives in NavBarsRouteReset.
//
// The `expo-router` mock below is REQUIRED by the NavBarsRouteReset block (NavBarsRouteReset
// reads usePathname). It is INERT for the applyVisibility / no-provider blocks:
// NavBarsContext imports NO expo-router (only react + react-native), so those members
// never load the module and are unaffected by the mock.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { Animated, Text } from 'react-native';
import { render, act } from '@testing-library/react-native';

import { resetRouter, setPathname } from './support/routerMock';

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import { applyVisibility, useNavBars, NavBarsProvider } from '../motion/NavBarsContext';
import { NavBarsRouteReset } from '../motion/NavBarsRouteReset';

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
});

// ===== WHIT-200 (folded from navBarsRouteReset.screen.test.tsx) =====
// NavBarsRouteReset is the single owner of the "reset bars to shown" lifecycle. It fires on
// ANY route change — a tab switch OR a detail push/pop. Drives the REAL NavBarsProvider +
// NavBarsRouteReset (reduceMotion:true so setNavBars snaps synchronously via setValue).
// Fail-on-revert: drop the useEffect in NavBarsRouteReset and the re-show assertion flips.
describe('WHIT-200 — NavBarsRouteReset detail push/pop (folded from navBarsRouteReset.screen.test.tsx)', () => {
  let captured: ReturnType<typeof useNavBars>;
  function Probe() {
    captured = useNavBars();
    return null;
  }

  // A FRESH element each call — reusing one constant element makes React bail out of
  // re-rendering NavBarsRouteReset on rerender, so usePathname wouldn't be re-read.
  const tree = () => (
    <NavBarsProvider reduceMotion={true}>
      <NavBarsRouteReset />
      <Probe />
    </NavBarsProvider>
  );

  const visValue = () => (captured.visibility as unknown as { __getValue(): number }).__getValue();

  beforeEach(() => resetRouter());

  it('re-shows the nav bars on a route change (detail push/pop)', () => {
    const view = render(tree());
    // Simulate scroll-hiding the bars on the current screen.
    act(() => captured.setNavBars('hidden'));
    expect(visValue()).toBe(0);

    // Push a detail route: pathname changes → the reset fires → bars come back.
    setPathname('/budget/1');
    view.rerender(tree());
    expect(visValue()).toBe(1);

    // Hide again, then pop back to the tab: pathname changes again → re-shown.
    act(() => captured.setNavBars('hidden'));
    expect(visValue()).toBe(0);
    setPathname('/budgets');
    view.rerender(tree());
    expect(visValue()).toBe(1);
  });
});
