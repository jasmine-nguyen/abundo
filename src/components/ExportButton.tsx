// WHIT-700 / WHIT-703: the Insights header's Export button — shares the selected cycle as an
// Excel (.xlsx) file.
import React, { useRef, useState } from 'react';
import { Alert } from 'react-native';
import { HeaderTextButton } from './ui';
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
    <HeaderTextButton
      label="Export"
      testID="insights-export"
      onPress={onPress}
      busy={busy}
      accessibilityLabel="Export this cycle's transactions as an Excel file"
    />
  );
}
