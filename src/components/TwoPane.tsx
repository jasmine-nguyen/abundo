import React from 'react';
import { View, StyleSheet } from 'react-native';
import { SafeAreaInsetsContext, useSafeAreaInsets } from 'react-native-safe-area-context';
import { C } from '../theme';
import { useWideLayout } from '../hooks/useWideLayout';

// ABU-110: list and detail side by side on a wide screen; just the list on a narrow one.
// Wide, the two panes are equal halves. The list keeps the same wrapper either way, so folding doesn't rebuild it (scroll position stays).
// Wide, each pane drops the safe edge on its divider side: the corners and status bar sit on the outer edges only.
export function TwoPane({ list, detail, empty }: {
  list: React.ReactNode;
  detail?: React.ReactNode;
  empty?: React.ReactNode;
}) {
  const wide = useWideLayout();
  const insets = useSafeAreaInsets();
  return (
    <View style={wide ? styles.row : styles.fill}>
      <View style={styles.fill}>
        <SafeAreaInsetsContext.Provider value={wide ? { ...insets, right: 0 } : insets}>{list}</SafeAreaInsetsContext.Provider>
      </View>
      {wide && (
        <>
          <View style={styles.divider} />
          <View style={styles.fill}>
            <SafeAreaInsetsContext.Provider value={{ ...insets, left: 0 }}>{detail || empty}</SafeAreaInsetsContext.Provider>
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  row: { flex: 1, flexDirection: 'row' },
  divider: { width: StyleSheet.hairlineWidth, backgroundColor: C.hairline },
});
