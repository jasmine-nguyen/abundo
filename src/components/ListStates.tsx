import type { ReactNode } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { useAppContext } from '../context';
import { C, FONT } from '../theme';
import { RetryButton } from './ui';
import { loadFailureReason, readFailureIsOffline } from '../apiError';
import { formatTimeOfDay } from '../dateutil';
import type { BankSyncedAccount } from '../queries';
import { TITLE_MAX_SCALE } from '../hooks/useLargeText';

// WHIT-489: the shared cold-load spinner + error/retry blocks for Transactions, Accounts,
// Insights and (via DetailStates, WHIT-771) the by-id detail screens. The two blocks are
// independent: each renders on its own flag, so both can show stacked. Screens interleave their
// own sections around this, so it renders only the two state blocks and no children. testIDs
// and copy are per-screen.
//
// WHIT-713: the optional `error` adds an offline-vs-server reason line under the error copy.
// This file also holds the shared quiet "Couldn't refresh · showing 9:40am" line (StaleDataLine),
// used by Budgets as well as the list tabs, and its opt-in "Updated 9:40am" version (WHIT-844),
// which Transactions and Accounts extend with a compact bank sync summary (WHIT-858) that opens a
// per-account sheet when tapped (ABU-82). The line lives in the screen header, under the title
// (WHIT-863).
export function ListStates({
  showSpinner, showError, idPrefix, errorText, retryLabel, onRetry, error,
}: {
  showSpinner: boolean;
  showError: boolean;
  idPrefix: string;
  errorText: string;
  retryLabel: string;
  onRetry: () => unknown;
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

// ABU-82: the one 24-hour rule shared by the line's "N behind" count and the sheet's amber dots.
export function isBankSyncBehind(account: BankSyncedAccount, now = Date.now()): boolean {
  return now - account.at > BANK_SYNC_STALE_MS;
}

// A refresh failed but the screen still shows its last good data: say so quietly, with when that
// data loaded. With `showUpdated` (WHIT-844), a good load says "Updated 9:40am" instead of
// nothing. Nothing when nothing has loaded yet. `bankSynced` (WHIT-858, ABU-82) appends a compact
// " · ● 1 account behind ›" (or " · Banks synced ›") and makes the line open the bank sync sheet.
export function StaleDataLine({ idPrefix, error, updatedAt, showUpdated, bankSynced = [] }: {
  idPrefix: string;
  error: unknown;
  updatedAt: number;
  showUpdated?: boolean;
  bankSynced?: BankSyncedAccount[];
}) {
  if (updatedAt === 0) return null;
  if (error == null && !showUpdated) return null;
  const time = formatTimeOfDay(updatedAt);
  let testID = `${idPrefix}-updated`;
  let lead = `Updated ${time}`;
  if (error != null) {
    testID = `${idPrefix}-stale`;
    lead = `${readFailureIsOffline(error) ? 'You look offline' : "Couldn't refresh"} · showing ${time}`;
  }
  const behind = bankSynced.filter((account) => isBankSyncBehind(account)).length;
  const line = (
    <Text testID={testID} style={styles.staleText} maxFontSizeMultiplier={TITLE_MAX_SCALE}>
      {lead}
      {bankSynced.length > 0 && <BankSyncSummary idPrefix={idPrefix} behind={behind} />}
    </Text>
  );
  if (bankSynced.length === 0) return line;
  return <BankSyncButton idPrefix={idPrefix} lead={lead} behind={behind} accounts={bankSynced}>{line}</BankSyncButton>;
}

function behindText(behind: number) {
  return `${behind} ${behind === 1 ? 'account' : 'accounts'} behind`;
}

function BankSyncSummary({ idPrefix, behind }: { idPrefix: string; behind: number }) {
  if (behind === 0) return <>{' · Banks synced ›'}</>;
  return (
    <>
      {' · '}
      <Text testID={`${idPrefix}-bank-sync-dot`} style={styles.bankSyncDot}>●</Text>
      {` ${behindText(behind)} ›`}
    </>
  );
}

// Reads the app context only here, so lines without bank times (Budgets, Insights) need no provider.
function BankSyncButton({ idPrefix, lead, behind, accounts, children }: {
  idPrefix: string;
  lead: string;
  behind: number;
  accounts: BankSyncedAccount[];
  children: ReactNode;
}) {
  const { setSheet } = useAppContext();
  let status = behindText(behind);
  if (behind === 0) status = 'banks synced';
  return (
    <Pressable
      testID={`${idPrefix}-bank-sync`}
      accessibilityRole="button"
      accessibilityLabel={`${lead}, ${status}. Show bank sync times`}
      hitSlop={8}
      onPress={() => setSheet({ mode: 'bankSync', accounts })}
    >
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  rowsState: { alignItems: 'center', justifyContent: 'center', paddingVertical: 60, gap: 14 },
  stateText: { fontFamily: FONT.body, fontSize: 14.5, color: C.textMid, textAlign: 'center' },
  staleText: { fontFamily: FONT.body, fontSize: 12.5, fontWeight: '500', color: C.textDim, textAlign: 'center', marginTop: 4 },
  bankSyncDot: { color: C.warn },
});
