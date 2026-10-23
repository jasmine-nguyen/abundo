import React from 'react';
import { View, StyleSheet, useWindowDimensions } from 'react-native';
import { SafeAreaInsetsContext, useSafeAreaInsets } from 'react-native-safe-area-context';
import { READABLE_MAX_WIDTH, useWideLayout } from '../hooks/useWideLayout';

// ABU-113: wide, the page sits in a centred column of readable width; narrow, it fills the screen.
// The same two Views render either way, so folding doesn't rebuild the page.
// Wide, the side insets shrink by the gutter beside the column, so the page only pads for what still overlaps it.
export function ReadableColumn({ children }: { children: React.ReactNode }) {
  const wide = useWideLayout();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const gutter = wide ? Math.max(0, (width - READABLE_MAX_WIDTH) / 2) : 0;
  const columnInsets = {
    ...insets,
    left: Math.max(0, insets.left - gutter),
    right: Math.max(0, insets.right - gutter),
  };
  return (
    <View style={wide ? styles.outerWide : styles.fill}>
      <View style={wide ? styles.columnWide : styles.column}>
        <SafeAreaInsetsContext.Provider value={columnInsets}>{children}</SafeAreaInsetsContext.Provider>
      </View>
    </View>
  );
}

// The tabs lay out their own wide screens; the index only redirects.
const FULL_WIDTH_ROUTES = ['index', '(tabs)'];

// The root stack's screenLayout: every other page gets the readable column.
export function stackScreenLayout({ route, children }: { route: { name: string }; children: React.ReactElement }) {
  if (FULL_WIDTH_ROUTES.includes(route.name)) return children;
  return <ReadableColumn>{children}</ReadableColumn>;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  outerWide: { flex: 1, alignItems: 'center' },
  column: { flex: 1, width: '100%' },
  columnWide: { flex: 1, width: '100%', maxWidth: READABLE_MAX_WIDTH },
});
