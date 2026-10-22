import React from 'react';
import { View, StyleSheet } from 'react-native';
import { C } from '../theme';
import { useWideLayout } from '../hooks/useWideLayout';

// ABU-110: list and detail side by side on a wide screen; just the list on a narrow one.
export function TwoPane({ list, detail, empty }: {
  list: React.ReactNode;
  detail?: React.ReactNode;
  empty?: React.ReactNode;
}) {
  const wide = useWideLayout();
  if (!wide) return <>{list}</>;
  return (
    <View style={styles.row}>
      <View style={styles.list}>{list}</View>
      <View style={styles.divider} />
      <View style={styles.detail}>{detail || empty}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flex: 1, flexDirection: 'row' },
  list: { width: 380 },
  divider: { width: StyleSheet.hairlineWidth, backgroundColor: C.hairline },
  detail: { flex: 1 },
});
