// WHIT-184/200 — the nav-bars motion primitives: the reduce-motion gate (instant vs
// tween) and the safe no-provider default (bare screens must render without a
// NavBarsProvider). Also guards that the provider stays navigation-free — it renders
// bare here with no router, which is why the route reset lives in NavBarsRouteReset.
//
// WHIT-459: the nav-bars screen-cluster tests are consolidated here. The `expo-router`
// mock below is REQUIRED by the folded NavBarsRouteReset blocks (NavBarsRouteReset reads
// usePathname). It is INERT for the applyVisibility / no-provider / provider-dedup blocks:
// NavBarsContext imports NO expo-router (only react + react-native), so those members
// never load the module and are unaffected by the mock.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { Animated, Text } from 'react-native';
import { render, act } from '@testing-library/react-native';

let mockPathname = '/budgets';
jest.mock('expo-router', () => ({ usePathname: () => mockPathname }));

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

// ===== WHIT-200 GAP (folded from navBarsProviderDedup.screen.test.tsx) =====
// The provider's OWN dedup guard: NavBarsProvider.setNavBars short-circuits when the
// requested state equals the current stateRef (NavBarsContext.tsx:63), so an in-flight
// show/hide tween isn't restarted by a redundant call. Reduce-motion is OFF so the guard
// is observed via whether Animated.timing is (re)started.
// Fail-on-revert: delete the `if (next === stateRef.current) return;` line and the
// "same-state is a no-op" assertions flip (timing fires when it shouldn't).
describe('WHIT-200 GAP — provider setNavBars dedup guard (folded from navBarsProviderDedup.screen.test.tsx)', () => {
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

  beforeEach(() => { mockPathname = '/budgets'; });

  it('re-shows the nav bars on a route change (detail push/pop)', () => {
    const view = render(tree());
    // Simulate scroll-hiding the bars on the current screen.
    act(() => captured.setNavBars('hidden'));
    expect(visValue()).toBe(0);

    // Push a detail route: pathname changes → the reset fires → bars come back.
    mockPathname = '/budget/1';
    view.rerender(tree());
    expect(visValue()).toBe(1);

    // Hide again, then pop back to the tab: pathname changes again → re-shown.
    act(() => captured.setNavBars('hidden'));
    expect(visValue()).toBe(0);
    mockPathname = '/budgets';
    view.rerender(tree());
    expect(visValue()).toBe(1);
  });

  it('leaves the bars alone while the route is unchanged (a hide is not undone mid-screen)', () => {
    render(tree());
    act(() => captured.setNavBars('hidden')); // scroll-hide, same route
    expect(visValue()).toBe(0);               // stays hidden — no spurious reset
  });
});

// ===== WHIT-200 GAP (folded from navBarsRouteResetShortList.screen.test.tsx) =====
// Locks the OTHER half the old focus-reset owned:
//   (1) a plain TAB->TAB switch (e.g. Budgets -> Insights, an UNWIRED short-list screen with
//       no scroll hook of its own) re-shows the bars — route reset is the ONLY thing that can,
//   (2) hidden immediately before a route change still ends 'shown' (the reset wins the race).
// reduceMotion:true so setNavBars snaps synchronously via setValue.
describe('WHIT-200 GAP — route reset on tab->tab / short list (folded from navBarsRouteResetShortList.screen.test.tsx)', () => {
  let captured: ReturnType<typeof useNavBars>;
  function Probe() { captured = useNavBars(); return null; }

  // Fresh element each call so React re-renders NavBarsRouteReset and re-reads usePathname.
  const tree = () => (
    <NavBarsProvider reduceMotion={true}>
      <NavBarsRouteReset />
      <Probe />
    </NavBarsProvider>
  );
  const visValue = () => (captured.visibility as unknown as { __getValue(): number }).__getValue();

  beforeEach(() => { mockPathname = '/budgets'; });

  it('a tab->tab switch onto an unwired short-list screen re-shows the bars', () => {
    const view = render(tree());
    act(() => captured.setNavBars('hidden'));        // bars hidden on Budgets (a long list)
    expect(visValue()).toBe(0);

    mockPathname = '/insights';                       // switch to a short, unscrollable tab
    view.rerender(tree());
    expect(visValue()).toBe(1);                       // re-shown by the route reset alone
  });

  it('a hide immediately before a route change still ends shown (reset wins)', () => {
    const view = render(tree());
    act(() => {
      captured.setNavBars('hidden');                  // last-gasp scroll-hide...
      mockPathname = '/transactions';                 // ...then a route change lands
    });
    view.rerender(tree());
    expect(visValue()).toBe(1);
  });
});
