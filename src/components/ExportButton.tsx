// WHIT-700 / WHIT-703: the Insights header's Export button — shares the selected cycle as an
// Excel (.xlsx) file.
import React, { useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text } from 'react-native';
import { C, FONT } from '../theme';
import { shareCycleExport } from '../cycleShare';
import type { Category } from '../types';

export function ExportButton({ cycle, category }: {
  cycle: number;
  category: (id: string) => Category | undefined;
}) {
  const [busy, setBusy] = useState(false);
  // A ref as well as state, so a quick second tap is ignored before the screen redraws.
  const running = useRef(false);

  const onPress = async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      await shareCycleExport(cycle, category);
    } catch {
      Alert.alert("Couldn't export", 'Please try again.');
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  return (
    <Pressable
      testID="insights-export"
      onPress={onPress}
      hitSlop={8}
      style={styles.hdrBtn}
      accessibilityRole="button"
      accessibilityLabel="Export this cycle's transactions as an Excel file"
      accessibilityState={{ busy }}
    >
      {busy ? <ActivityIndicator color={C.accentSoft} /> : <Text style={styles.hdrBtnText}>Export</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  hdrBtn: { height: 40, paddingHorizontal: 8, alignItems: 'flex-end', justifyContent: 'center' },
  hdrBtnText: { fontFamily: FONT.body, fontSize: 14.5, fontWeight: '700', color: C.accentSoft },
});
