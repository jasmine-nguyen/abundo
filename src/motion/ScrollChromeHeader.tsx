// WHIT-199 — the shared floating-header + scroll-hide ScrollView that every tab screen uses.
// Extracts the block WHIT-184/WHIT-200 left copy-pasted in Transactions/Budgets, and gives
// Insights/Goals/Settings the same scroll-to-hide chrome. Owns the geometry (via
// useNavBarsHeader) so a screen supplies only its title, optional header actions, and its
// scrolling content. A centered title falls out of the default 40px spacers on BOTH sides;
// pass `right` (and/or `left`) for the action-button screens. All motion (the header
// hide/show) is the shared hook's, which already honours reduce-motion at the provider.
import React from 'react';
import { View, Text, Animated, ScrollView, StyleSheet, StyleProp, ViewStyle, RefreshControlProps } from 'react-native';
import { C, FONT } from '../theme';
import { useNavBarsHeader, floatingHeaderStyle } from './useNavBarsHeader';

export const SCREEN_PADDING = 18;
// The title sits in HEADER_BODY_HEIGHT minus 18px of padding (40px). 19px × 1.5 still fits, so at
// the biggest text sizes it can't grow over the top of the screen's first card (WHIT-743).
const TITLE_MAX_SCALE = 1.5;

export function ScrollChromeHeader({
  title, left, right, refreshControl, contentContainerStyle, keyboardShouldPersistTaps, children,
}: {
  title: string;
  left?: React.ReactNode;
  right?: React.ReactNode;
  // A render-prop so the screen keeps full control of its RefreshControl while the wrapper
  // supplies headerHeight — the RefreshControl MUST offset its spinner by it (progressViewOffset),
  // or the spinner draws behind the opaque floating header at y≈0 (WHIT-211).
  refreshControl?: (headerHeight: number) => React.ReactElement<RefreshControlProps>;
  contentContainerStyle?: StyleProp<ViewStyle>;
  // Forwarded to the ScrollView — a screen with a search field passes 'handled' so a tap on a
  // result lands instead of only dismissing the keyboard. Omitted → RN's default (unchanged).
  keyboardShouldPersistTaps?: 'always' | 'never' | 'handled';
  children: React.ReactNode;
}) {
  const { onScroll, scrollEventThrottle, headerStyle, headerHeight, headerPaddingTop, statusBarHeight, contentPadding } = useNavBarsHeader();
  return (
    <View style={{ flex: 1 }}>
      <View pointerEvents="none" style={[styles.statusStrip, { height: statusBarHeight }]} />
      <Animated.View style={[floatingHeaderStyle, { paddingTop: headerPaddingTop }, headerStyle]}>
        {left ?? <View style={styles.slot} />}
        <Text style={styles.title} maxFontSizeMultiplier={TITLE_MAX_SCALE}>{title}</Text>
        {right ?? <View style={styles.slot} />}
      </Animated.View>

      <ScrollView
        onScroll={onScroll}
        scrollEventThrottle={scrollEventThrottle}
        // Flatten to a single object so `contentContainerStyle.paddingTop/Bottom` stays
        // directly readable (the motion/clearance tests inspect it), while still folding in
        // a screen's extra style (e.g. Budgets' flexGrow for its centered spinner/error).
        contentContainerStyle={StyleSheet.flatten([{ paddingHorizontal: SCREEN_PADDING, ...contentPadding }, contentContainerStyle])}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps={keyboardShouldPersistTaps}
        refreshControl={refreshControl?.(headerHeight)}
      >
        {children}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  // A fixed 40px slot on each side of the title. Both filled (default spacers) → the title
  // centres, matching the old Insights/Goals/Settings centred headers. One replaced by an
  // action button → the title stays centred against the opposite spacer (Transactions/Budgets).
  slot: { width: 40 },
  // Sits above the sliding header (zIndex 10) so the status bar keeps a solid backing when it hides.
  statusStrip: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 11, backgroundColor: C.bg },
  title: { fontFamily: FONT.display, fontWeight: '700', fontSize: 19, color: C.textBright, letterSpacing: -0.2 },
});
