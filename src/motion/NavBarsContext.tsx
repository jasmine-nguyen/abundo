// WHIT-184/200 — the shared signal that lets the (per-screen) header and the (separate)
// bottom tab bar hide together from one scroll gesture. "Nav bars" = both of those app
// bars. Holds a single Animated.Value `visibility` (1 = bars shown, 0 = hidden) plus the
// authoritative `stateRef` that the scroll hook reads. Deliberately its OWN context, NOT
// the hot src/context.tsx AppProvider.
import React, { createContext, useContext, useMemo, useRef } from 'react';
import { Animated, Easing } from 'react-native';
import type { NavBarsState } from './navBarsVisibility';

const SHOW_DURATION_MS = 200;

// Drive `value` to `target` (0/1). When reduce-motion is on, jump instantly with
// setValue (no animation frames); otherwise a short transform/opacity tween on the
// native driver. Exported so the reduce-motion gate is directly testable.
export function applyVisibility(value: Animated.Value, target: number, reduceMotion: boolean): void {
  if (reduceMotion) {
    value.setValue(target);
    return;
  }
  Animated.timing(value, {
    toValue: target,
    duration: SHOW_DURATION_MS,
    easing: Easing.out(Easing.cubic),
    useNativeDriver: true,
  }).start();
}

interface NavBarsContextValue {
  visibility: Animated.Value; // 1 = shown, 0 = hidden
  setNavBars: (state: NavBarsState) => void;
  // The single source of truth for the current shown/hidden state. The scroll hook reads
  // this (rather than keeping its own copy) so state has ONE owner and can't drift.
  stateRef: React.MutableRefObject<NavBarsState>;
}

// Safe default so a screen that reads the nav bars renders WITHOUT a provider — the bare
// screen render tests mount <Transactions/> / <Budgets/> with no NavBarsProvider, and
// must not crash. A standalone always-shown value + a no-op setter: no crash, no motion.
const DEFAULT_VALUE: NavBarsContextValue = {
  visibility: new Animated.Value(1),
  setNavBars: () => {},
  stateRef: { current: 'shown' },
};

const NavBarsCtx = createContext<NavBarsContextValue>(DEFAULT_VALUE);

export function useNavBars(): NavBarsContextValue {
  return useContext(NavBarsCtx);
}

// `reduceMotion` is passed in (the tabs layout owns the useReduceMotion hook and also
// feeds it to the native tab-switch animation), so this provider stays a pure consumer
// of the flag and is trivial to test with either value. It intentionally does NOT read
// navigation state — see NavBarsRouteReset — so it can be rendered bare in tests.
export function NavBarsProvider({ reduceMotion, children }: { reduceMotion: boolean; children: React.ReactNode }) {
  const visibility = useRef(new Animated.Value(1)).current;
  const stateRef = useRef<NavBarsState>('shown');

  const value = useMemo<NavBarsContextValue>(() => ({
    visibility,
    stateRef,
    setNavBars: (next: NavBarsState) => {
      if (next === stateRef.current) return; // don't restart an in-flight tween redundantly
      stateRef.current = next;
      applyVisibility(visibility, next === 'shown' ? 1 : 0, reduceMotion);
    },
  }), [visibility, reduceMotion]);

  return <NavBarsCtx.Provider value={value}>{children}</NavBarsCtx.Provider>;
}
