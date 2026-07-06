// WHIT-184/200 — screen-side hook: turn a ScrollView's onScroll into nav-bars hide/show
// and hand back the animated style for that screen's header. State has a single owner —
// the provider's stateRef (read here, written via setNavBars) — so the hook keeps no
// chrome state of its own; the "reset to shown" lifecycle lives entirely in
// NavBarsRouteReset. `prevY` here is per-ScrollView scroll geometry, not chrome state.
//
// Usually consumed via useNavBarsHeader(), which owns the header geometry; call this
// directly only if a screen needs a custom header height.
import { useCallback, useRef } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { useNavBars } from './NavBarsContext';
import { nextNavBarsState } from './navBarsVisibility';

export function useScrollNavBars(headerHeight: number) {
  const { visibility, setNavBars, stateRef } = useNavBars();
  const prevY = useRef(0);

  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = e.nativeEvent.contentOffset.y;
    const next = nextNavBarsState(stateRef.current, { y, prevY: prevY.current });
    prevY.current = y;
    if (next !== stateRef.current) setNavBars(next);
  }, [setNavBars, stateRef]);

  // 1 = shown (translateY 0, opaque), 0 = hidden (slid up by its full height, faded).
  const headerStyle = {
    opacity: visibility,
    transform: [{ translateY: visibility.interpolate({ inputRange: [0, 1], outputRange: [-headerHeight, 0] }) }],
  };

  return { onScroll, scrollEventThrottle: 16, headerStyle };
}
