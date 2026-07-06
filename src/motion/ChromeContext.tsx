// WHIT-184 — the shared signal that lets the (per-screen) header and the (separate)
// bottom tab bar hide together from one scroll gesture. Holds a single Animated.Value
// `visibility` (1 = chrome shown, 0 = hidden); consumers interpolate it into a
// transform. Deliberately its OWN context, NOT the hot src/context.tsx AppProvider.
import React, { createContext, useContext, useMemo, useRef } from 'react';
import { Animated, Easing } from 'react-native';
import type { ChromeState } from './chromeVisibility';

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

interface ChromeContextValue {
  visibility: Animated.Value; // 1 = shown, 0 = hidden
  setChrome: (state: ChromeState) => void;
}

// Safe default so a screen that reads chrome renders WITHOUT a provider — the bare
// screen render tests mount <Transactions/> / <Budgets/> with no ChromeProvider, and
// must not crash. A standalone always-shown value + a no-op setter: no crash, no motion.
const DEFAULT_VALUE: ChromeContextValue = {
  visibility: new Animated.Value(1),
  setChrome: () => {},
};

const ChromeCtx = createContext<ChromeContextValue>(DEFAULT_VALUE);

export function useChrome(): ChromeContextValue {
  return useContext(ChromeCtx);
}

// `reduceMotion` is passed in (the tabs layout owns the useReduceMotion hook and also
// feeds it to the native tab-switch animation), so this provider stays a pure consumer
// of the flag and is trivial to test with either value.
export function ChromeProvider({ reduceMotion, children }: { reduceMotion: boolean; children: React.ReactNode }) {
  const visibility = useRef(new Animated.Value(1)).current;
  const stateRef = useRef<ChromeState>('shown');

  const value = useMemo<ChromeContextValue>(() => ({
    visibility,
    setChrome: (next: ChromeState) => {
      if (next === stateRef.current) return; // don't restart an in-flight tween redundantly
      stateRef.current = next;
      applyVisibility(visibility, next === 'shown' ? 1 : 0, reduceMotion);
    },
  }), [visibility, reduceMotion]);

  return <ChromeCtx.Provider value={value}>{children}</ChromeCtx.Provider>;
}
