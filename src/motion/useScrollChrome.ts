// WHIT-184 — screen-side hook: turn a ScrollView's onScroll into chrome hide/show,
// hand back the animated style for that screen's header, and reset chrome to shown
// whenever the screen regains focus (so hiding on one tab never leaves the header /
// tab bar stranded hidden when you switch tabs or land on a short, unscrollable list).
//
// Usage: const { onScroll, scrollEventThrottle, headerStyle } = useScrollChrome(headerHeight)
//   - spread onScroll + scrollEventThrottle onto the ScrollView
//   - apply headerStyle to the header (an Animated.View), which slides up + fades out
import { useCallback, useRef } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useChrome } from './ChromeContext';
import { nextChromeState, type ChromeState } from './chromeVisibility';

// A tab screen's header is a fixed-height row (a ~40px action button) with paddingTop
// insets.top + 6 and paddingBottom 12. Screens compute headerHeight = insets.top +
// HEADER_BODY_HEIGHT, used for BOTH the ScrollView's top inset (content clears the
// floating header at rest) and the hidden-state slide distance (header goes fully off).
export const HEADER_BODY_HEIGHT = 58;

export function useScrollChrome(headerHeight: number) {
  const { visibility, setChrome } = useChrome();
  const prevY = useRef(0);
  const stateRef = useRef<ChromeState>('shown');

  const applyState = useCallback((next: ChromeState) => {
    if (next === stateRef.current) return;
    stateRef.current = next;
    setChrome(next);
  }, [setChrome]);

  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = e.nativeEvent.contentOffset.y;
    const next = nextChromeState(stateRef.current, { y, prevY: prevY.current });
    prevY.current = y;
    applyState(next);
  }, [applyState]);

  // Reset to shown on focus — covers tab switches and re-entering a short list.
  useFocusEffect(useCallback(() => {
    prevY.current = 0;
    applyState('shown');
  }, [applyState]));

  // 1 = shown (translateY 0, opaque), 0 = hidden (slid up by its full height, faded).
  const headerStyle = {
    opacity: visibility,
    transform: [{ translateY: visibility.interpolate({ inputRange: [0, 1], outputRange: [-headerHeight, 0] }) }],
  };

  return { onScroll, scrollEventThrottle: 16, headerStyle };
}
