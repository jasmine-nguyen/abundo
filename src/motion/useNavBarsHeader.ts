// WHIT-200 — one home for the floating-header geometry that Transactions and Budgets
// (and, later, the other tab screens) share. Owns the header height, the list's top/
// bottom insets, and the scroll wiring so each screen just spreads the result. Extracted
// from the near-identical blocks the two screens carried after WHIT-184.
import { StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C } from '../theme';
import { useScrollNavBars } from './useScrollNavBars';

// A tab screen's header is a fixed-height row (a ~40px action button) with paddingTop
// insets.top + 6 and paddingBottom 12. headerHeight = insets.top + HEADER_BODY_HEIGHT is
// used for BOTH the list's top inset (content clears the floating header at rest) and the
// hidden-state slide distance (header goes fully off-screen).
export const HEADER_BODY_HEIGHT = 58;

// Bottom padding that keeps list content clear of the floating (absolute) tab bar. The
// bar's measured height is ~67–100px; this is the comfortable gap above it, shared by
// every tab list so the number lives in exactly one place.
export const TAB_BAR_CLEARANCE = 120;

// The absolute, opaque header shell shared verbatim by the floating-header screens. The
// per-screen paddingTop (safe-area inset) and the animated headerStyle are layered on top.
export const floatingHeaderStyle = StyleSheet.create({
  header: {
    position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10, backgroundColor: C.bg,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingBottom: 12,
  },
}).header;

export function useNavBarsHeader() {
  const insets = useSafeAreaInsets();
  const headerHeight = insets.top + HEADER_BODY_HEIGHT;
  const { onScroll, scrollEventThrottle, headerStyle } = useScrollNavBars(headerHeight);
  return {
    onScroll,
    scrollEventThrottle,
    headerStyle,
    // Layer under floatingHeaderStyle: the safe-area top padding.
    headerPaddingTop: insets.top + 6,
    // Spread into the ScrollView's contentContainerStyle.
    contentPadding: { paddingTop: headerHeight, paddingBottom: TAB_BAR_CLEARANCE },
  };
}
