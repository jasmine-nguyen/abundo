import React from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { C, FONT } from '../theme';
import { RetryButton } from './ui';

// WHIT-276: the cache-first loading/error/retry scaffold shared by the by-id detail screens
// (transaction/[id], account/[id]). Both read one thing from the SAME cached list, so both
// gate the spinner/error the same way: only show them when there is NOTHING cached to render
// yet — a background refetch over cached rows keeps the content up. Each screen supplies its
// own loaded content + its own empty state as children; this owns only the shared scaffold.
//
// idPrefix produces the testIDs `${idPrefix}-loading` / `${idPrefix}-error` / `${idPrefix}-retry`
// (e.g. transaction-loading, account-retry).
//
// Spinner and error are INDEPENDENT conditions, not an either/or: isLoading and isError come
// from two combined queries and can both be true at once (one query erroring while the other
// retries with an empty cache), so both blocks can render stacked — matching the originals.
export function DetailStates({ isLoading, isError, hasCache, idPrefix, errorText, retryLabel, onRetry, children }: {
  isLoading: boolean; isError: boolean; hasCache: boolean;
  idPrefix: string; errorText: string; retryLabel: string;
  onRetry: () => void; children: React.ReactNode;
}) {
  const showSpinner = isLoading && !hasCache;
  const showError = isError && !hasCache;

  return (
    <>
      {showSpinner && (
        <View testID={`${idPrefix}-loading`} style={styles.state}>
          <ActivityIndicator color={C.accent} />
        </View>
      )}

      {showError && (
        <View testID={`${idPrefix}-error`} style={styles.state}>
          <Text style={styles.stateText}>{errorText}</Text>
          <RetryButton onPress={onRetry} label={retryLabel} testID={`${idPrefix}-retry`} style={styles.retryBtn} textStyle={styles.retryText} />
        </View>
      )}

      {!showSpinner && !showError && <>{children}</>}
    </>
  );
}

const styles = StyleSheet.create({
  state: { alignItems: 'center', justifyContent: 'center', paddingVertical: 60, gap: 14 },
  stateText: { fontFamily: FONT.body, fontSize: 14.5, color: C.textMid, textAlign: 'center' },
  retryBtn: { paddingVertical: 10, paddingHorizontal: 22, borderRadius: 12, backgroundColor: 'rgba(124,140,255,.16)' },
  retryText: { fontFamily: FONT.body, fontSize: 14, fontWeight: '700', color: C.accentSoft },
});
