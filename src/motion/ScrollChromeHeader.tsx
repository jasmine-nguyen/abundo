// WHIT-199 — the shared floating-header + scroll-hide ScrollView that every tab screen uses.
// Extracts the block WHIT-184/WHIT-200 left copy-pasted in Transactions/Budgets, and gives
// Insights/Goals/Settings the same scroll-to-hide chrome. Owns the geometry and the scroll
// wiring so a screen supplies only its title, optional header actions, and its scrolling
// content. The header draws the Settings gear on the left itself, so no tab can lose it; a
// 40px spacer on the right keeps the title centred unless a screen passes `right`. Nav-bars
// state has a single owner —
// the provider's stateRef (read here, written via setNavBars), which also honours
// reduce-motion. `prevY` is per-ScrollView scroll geometry, not chrome state.
import React, { useCallback, useRef } from 'react';
import { View, Text, Animated, ScrollView, StyleSheet, StyleProp, ViewStyle, RefreshControl } from 'react-native';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, FONT } from '../theme';
import { useNavBars } from './NavBarsContext';
import { SettingsButton } from '../components/SettingsButton';
import { nextNavBarsState } from './navBarsVisibility';

// A tab screen's header is a fixed-height row (a ~40px action button) with paddingTop
// insets.top + 6 and paddingBottom 12. headerHeight = insets.top + HEADER_BODY_HEIGHT is
// used for BOTH the list's top inset (content clears the floating header at rest) and the
// hidden-state slide distance (header goes fully off-screen).
export const HEADER_BODY_HEIGHT = 58;

// Bottom padding that keeps list content clear of the floating (absolute) tab bar. The
// bar's measured height is ~67–100px; this is the comfortable gap above it, shared by
// every tab list so the number lives in exactly one place.
export const TAB_BAR_CLEARANCE = 120;

// Extra bottom padding so the last row of a tab list can scroll clear of the floating round Ask
// button that sits above the tab bar (card 609).
export const ASK_BUTTON_BOTTOM_CLEARANCE = 72;

// The absolute, opaque header shell. The safe-area paddingTop and the animated slide/fade
// are layered on top.
export const floatingHeaderStyle = StyleSheet.create({
  header: {
    position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10, backgroundColor: C.bg,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingBottom: 12,
  },
}).header;

export const SCREEN_PADDING = 18;
// The title sits in HEADER_BODY_HEIGHT minus 18px of padding (40px). 19px × 1.5 still fits, so at
// the biggest text sizes it can't grow over the top of the screen's first card (WHIT-743).
const TITLE_MAX_SCALE = 1.5;

export function ScrollChromeHeader({
  title, right, refreshing, onRefresh, contentContainerStyle, keyboardShouldPersistTaps, children,
}: {
  title: string;
  right?: React.ReactNode;
  // Given onRefresh, the wrapper builds the pull-to-refresh spinner, offset by headerHeight so it
  // doesn't draw behind the opaque floating header at y≈0 (WHIT-211). No onRefresh → no spinner.
  refreshing?: boolean;
  onRefresh?: () => void;
  contentContainerStyle?: StyleProp<ViewStyle>;
  // Forwarded to the ScrollView — a screen with a search field passes 'handled' so a tap on a
  // result lands instead of only dismissing the keyboard. Omitted → RN's default (unchanged).
  keyboardShouldPersistTaps?: 'always' | 'never' | 'handled';
  children: React.ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const headerHeight = insets.top + HEADER_BODY_HEIGHT;
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

  return (
    <View style={{ flex: 1 }}>
      <View pointerEvents="none" style={[styles.statusStrip, { height: insets.top }]} />
      <Animated.View style={[floatingHeaderStyle, { paddingTop: insets.top + 6 }, headerStyle]}>
        <SettingsButton />
        <Text style={styles.title} maxFontSizeMultiplier={TITLE_MAX_SCALE}>{title}</Text>
        {right ?? <View style={styles.slot} />}
      </Animated.View>

      <ScrollView
        onScroll={onScroll}
        scrollEventThrottle={16}
        // Flatten to a single object so `contentContainerStyle.paddingTop/Bottom` stays
        // directly readable (the motion/clearance tests inspect it), while still folding in
        // a screen's extra style (e.g. Transactions' select-mode bottom padding).
        contentContainerStyle={StyleSheet.flatten([
          {
            // Fill the viewport so a short list (or a centred spinner/error) can still be pulled to refresh.
            flexGrow: 1,
            paddingHorizontal: SCREEN_PADDING,
            paddingTop: headerHeight,
            paddingBottom: TAB_BAR_CLEARANCE + ASK_BUTTON_BOTTOM_CLEARANCE,
          },
          contentContainerStyle,
        ])}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps={keyboardShouldPersistTaps}
        refreshControl={onRefresh && (
          <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={C.accent} progressViewOffset={headerHeight} />
        )}
      >
        {children}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  // The right-hand 40px spacer, as wide as the gear on the left, so the title stays centred
  // when a screen has no right action.
  slot: { width: 40 },
  // Sits above the sliding header (zIndex 10) so the status bar keeps a solid backing when it hides.
  statusStrip: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 11, backgroundColor: C.bg },
  title: { fontFamily: FONT.display, fontWeight: '700', fontSize: 19, color: C.textBright, letterSpacing: -0.2 },
});
