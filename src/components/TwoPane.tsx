import React from 'react';
import { View, StyleSheet } from 'react-native';
import { C } from '../theme';
import { useWideLayout } from '../hooks/useWideLayout';

// ABU-110: list and detail side by side on a wide screen; just the list on a narrow one.
// The list keeps the same wrapper either way, so folding doesn't rebuild it (scroll position stays).
export function TwoPane({ list, detail, empty }: {
  list: React.ReactNode;
  detail?: React.ReactNode;
  empty?: React.ReactNode;
}) {
  const wide = useWideLayout();
  return (
    <View style={wide ? styles.row : styles.fill}>
      <View style={wide ? styles.list : styles.fill}>{list}</View>
      {wide && (
        <>
          <View style={styles.divider} />
          <View style={styles.fill}>{detail || empty}</View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  row: { flex: 1, flexDirection: 'row' },
  // Half the width, up to 380: on the Duo's ~626–669pt inner screen the detail must not be squeezed.
  list: { flex: 1, maxWidth: 380 },
  divider: { width: StyleSheet.hairlineWidth, backgroundColor: C.hairline },
});
