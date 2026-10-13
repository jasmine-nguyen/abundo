import { Fragment } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { C, FONT } from '../theme';
import { RetryButton } from './ui';
import { loadFailureReason, readFailureIsOffline } from '../apiError';
import { formatTimeOfDay } from '../dateutil';
import type { BankSyncedAccount } from '../queries';

// WHIT-489: the shared cold-load spinner + error/retry blocks for Transactions, Accounts,
// Insights and (via DetailStates, WHIT-771) the by-id detail screens. The two blocks are
// independent: each renders on its own flag, so both can show stacked. Screens interleave their
// own sections around this, so it renders only the two state blocks and no children. testIDs
// and copy are per-screen.
//
// WHIT-713: the optional `error` adds an offline-vs-server reason line under the error copy.
// This file also holds the shared quiet "Couldn't refresh · showing 9:40am" line (StaleDataLine),
// used by Budgets as well as the list tabs, and its opt-in "Updated 9:40am" version (WHIT-844),
// which Transactions extends with each account's "Bank synced" time (WHIT-858).
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
          <RetryButton onPress={onRetry} label={retryLabel} testID={`${idPrefix}-retry`} />
        </View>
      )}
    </>
  );
}

const BANK_SYNC_STALE_MS = 24 * 60 * 60 * 1000;

// A refresh failed but the screen still shows its last good data: say so quietly, with when that
// data loaded. With `showUpdated` (WHIT-844), a good load says "Updated 9:40am" instead of
// nothing. Nothing when nothing has loaded yet. `bankSynced` (WHIT-858) appends
// " · Bank synced <account> <time> · …", each entry amber once over a day old.
export function StaleDataLine({ idPrefix, error, updatedAt, showUpdated, bankSynced = [] }: {
  idPrefix: string;
  error: unknown;
  updatedAt: number;
  showUpdated?: boolean;
  bankSynced?: BankSyncedAccount[];
}) {
  if (updatedAt === 0) return null;
  const bankPart = bankSynced.length > 0 && (
    <>
      {' · Bank synced '}
      {bankSynced.map((account, index) => (
        <Fragment key={account.id}>
          {index > 0 && ' · '}
          <Text
            testID={`${idPrefix}-bank-synced-${account.id}`}
            style={Date.now() - account.at > BANK_SYNC_STALE_MS && styles.bankSyncStale}
          >
            {`${account.name} ${formatTimeOfDay(account.at)}`}
          </Text>
        </Fragment>
      ))}
    </>
  );
  if (error != null) {
    const lead = readFailureIsOffline(error) ? 'You look offline' : "Couldn't refresh";
    return <Text testID={`${idPrefix}-stale`} style={styles.staleText}>{`${lead} · showing ${formatTimeOfDay(updatedAt)}`}{bankPart}</Text>;
  }
  if (!showUpdated) return null;
  return <Text testID={`${idPrefix}-updated`} style={styles.staleText}>{`Updated ${formatTimeOfDay(updatedAt)}`}{bankPart}</Text>;
}

const styles = StyleSheet.create({
  rowsState: { alignItems: 'center', justifyContent: 'center', paddingVertical: 60, gap: 14 },
  stateText: { fontFamily: FONT.body, fontSize: 14.5, color: C.textMid, textAlign: 'center' },
  staleText: { fontFamily: FONT.body, fontSize: 12.5, fontWeight: '500', color: C.textDim, marginHorizontal: 4, marginBottom: 10 },
  bankSyncStale: { color: C.warn },
});
