import React from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { C, FONT, tint } from '../theme';
import { RetryButton } from './ui';

// WHIT-489: the shared cold-load spinner + error/retry blocks for the list tabs (Transactions,
// Accounts). Spinner and error are mutually exclusive there (the screen computes `showSpinner`
// as `!showError && …`), and the screen interleaves its own sections around this, so this
// renders only the two state blocks and no children. testIDs and copy are per-screen.
export function ListStates({
  showSpinner, showError, idPrefix, errorText, retryLabel, onRetry,
}: {
  showSpinner: boolean;
  showError: boolean;
  idPrefix: string;
  errorText: string;
  retryLabel: string;
  onRetry: () => void;
}) {
  return (
    <>
      {showSpinner && (
        <View testID={`${idPrefix}-loading`} style={styles.rowsState}>
          <ActivityIndicator color={C.accent} />
        </View>
      )}
      {showError && (
        <View testID={`${idPrefix}-error`} style={styles.rowsState}>
          <Text style={styles.stateText}>{errorText}</Text>
          <RetryButton onPress={onRetry} label={retryLabel} testID={`${idPrefix}-retry`} style={styles.retryBtn} textStyle={styles.retryText} />
        </View>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  rowsState: { alignItems: 'center', justifyContent: 'center', paddingVertical: 60, gap: 14 },
  stateText: { fontFamily: FONT.body, fontSize: 14.5, color: C.textMid, textAlign: 'center' },
  retryBtn: { paddingVertical: 10, paddingHorizontal: 22, borderRadius: 12, backgroundColor: tint(C.accentAlt, 0.16) },
  retryText: { fontFamily: FONT.body, fontSize: 14, fontWeight: '700', color: C.accentSoft },
});
