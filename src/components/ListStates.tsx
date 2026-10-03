import React from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { C, FONT, tint } from '../theme';
import { RetryButton } from './ui';
import { loadFailureReason, readFailureIsOffline } from '../apiError';
import { formatTimeOfDay } from '../dateutil';

// WHIT-489: the shared cold-load spinner + error/retry blocks for the list tabs (Transactions,
// Accounts). Spinner and error are mutually exclusive there (the screen computes `showSpinner`
// as `!showError && …`), and the screen interleaves its own sections around this, so this
// renders only the two state blocks and no children. testIDs and copy are per-screen.
//
// WHIT-713: the optional `error` adds an offline-vs-server reason line under the error copy.
// This file also holds the shared quiet "Couldn't refresh · showing 9:40am" line (StaleDataLine),
// used by Budgets as well as the list tabs.
export function ListStates({
  showSpinner, showError, idPrefix, errorText, retryLabel, onRetry, error,
}: {
  showSpinner: boolean;
  showError: boolean;
  idPrefix: string;
  errorText: string;
  retryLabel: string;
  onRetry: () => void;
  error?: unknown;
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
          {error != null && <Text style={styles.stateText}>{loadFailureReason(error)}</Text>}
          <RetryButton onPress={onRetry} label={retryLabel} testID={`${idPrefix}-retry`} style={styles.retryBtn} textStyle={styles.retryText} />
        </View>
      )}
    </>
  );
}

// A refresh failed but the screen still shows its last good data: say so quietly, with when that
// data loaded. Nothing when the last refresh worked or nothing has loaded yet.
export function StaleDataLine({ idPrefix, error, updatedAt }: { idPrefix: string; error: unknown; updatedAt: number }) {
  if (error == null || updatedAt === 0) return null;
  const lead = readFailureIsOffline(error) ? 'You look offline' : "Couldn't refresh";
  return <Text testID={`${idPrefix}-stale`} style={styles.staleText}>{`${lead} · showing ${formatTimeOfDay(updatedAt)}`}</Text>;
}

const styles = StyleSheet.create({
  rowsState: { alignItems: 'center', justifyContent: 'center', paddingVertical: 60, gap: 14 },
  stateText: { fontFamily: FONT.body, fontSize: 14.5, color: C.textMid, textAlign: 'center' },
  retryBtn: { paddingVertical: 10, paddingHorizontal: 22, borderRadius: 12, backgroundColor: tint(C.accentAlt, 0.16) },
  retryText: { fontFamily: FONT.body, fontSize: 14, fontWeight: '700', color: C.accentSoft },
  staleText: { fontFamily: FONT.body, fontSize: 12.5, fontWeight: '500', color: C.textDim, marginHorizontal: 4, marginBottom: 10 },
});
