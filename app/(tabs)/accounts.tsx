import { useCallback } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { C, FONT, tint, fmtBalance, ACCOUNT_ACCENTS, PRESSED } from '../../src/theme';
import { Icon, Glyph } from '../../src/icons';
import { accountSummaries, useAppContext } from '../../src/context';
import { useTransactionsScreenData } from '../../src/queries';
import { usePullToRefresh } from '../../src/hooks/usePullToRefresh';
import { ScrollChromeHeader } from '../../src/motion/ScrollChromeHeader';
import { ListStates, StaleDataLine } from '../../src/components/ListStates';
import { EmptyState } from '../../src/components/EmptyState';

// The Accounts tab. Lifted out of the Transactions segmented control into its own bottom-bar
// tab: it derives one card per account_id from the same transactions query the Transactions
// tab uses plus the saved balances, shows live balances (poller-fed), and taps through to
// /account/[id].
export default function Accounts() {
  const router = useRouter();
  const { showToast } = useAppContext();
  // Same data source as the old segment — the all-accounts cursor feed — so behaviour and the
  // cold-load/error states are identical to before the move.
  const { transactions, balances, isLoading, isError, error, refreshError, updatedAt, refetch, refetchStale, refetchList, refreshLiveBalances } = useTransactionsScreenData();
  useFocusEffect(useCallback(() => { refetchStale(); }, [refetchStale]));

  // WHIT-215: derived from the transactions themselves (one card per account_id), not a
  // hardcoded list — so names always match what's in the data. WHIT-643: plus every account
  // with a saved balance, so a quiet account (the home loan) still gets a card.
  const accounts = accountSummaries({ transactions }, balances.keys());

  const showError = isError && transactions.length === 0;
  const showSpinner = !showError && isLoading && transactions.length === 0;
  // Pull-to-refresh (WHIT-489: shared hook): refresh the visible list AND fetch fresh account
  // balances live from the bank, with the WHIT-363 stuck-spinner invariant owned in one place.
  // A successful pull confirms itself with "Balances up to date" — a live refresh often returns
  // the same number (unchanged balance, or the server's 60s throttle), so without this feedback
  // an intact pull looks like it did nothing.
  const { pulling, onRefresh } = usePullToRefresh(refetchList, refreshLiveBalances, showToast, 'Balances up to date');

  return (
    <ScrollChromeHeader
      title="Accounts"
      // Show the pull spinner for a user pull unless the cold-load spinner owns the screen
      // (WHIT-363: never double-spin). `!showSpinner` — not `transactions.length > 0` — so a
      // pull on the settled "No accounts yet" empty state still shows feedback, now that the
      // header's full-height content makes that short state pullable.
      refreshing={pulling && !showSpinner}
      onRefresh={onRefresh}
    >
      {!showError && <StaleDataLine idPrefix="accounts" error={refreshError} updatedAt={updatedAt} />}
      <ListStates
        showSpinner={showSpinner}
        showError={showError}
        idPrefix="accounts"
        errorText="Couldn't load your accounts."
        retryLabel="Retry loading your accounts"
        onRetry={refetch}
        error={error}
      />

      {!showSpinner && !showError && accounts.length === 0 && (
        <EmptyState
          icon={<Glyph name="wallet" size={32} color={C.accentSoft} />}
          title="No accounts yet"
          sub="Your linked accounts show up here once transactions sync."
        />
      )}

      {!showSpinner && !showError && accounts.length > 0 && (
        <View style={{ marginTop: 14 }}>
          {accounts.map((a, i) => {
            const color = ACCOUNT_ACCENTS[i % ACCOUNT_ACCENTS.length];
            // WHIT-212: signed live balance from the poller-fed query — green when in credit,
            // red when owing. Absent until the account's first poll → a dim "—".
            const bal = balances.get(a.id);
            let subtitle = `${a.count} ${a.count === 1 ? 'transaction' : 'transactions'}`;
            if (a.count === 0) subtitle = 'No recent transactions';
            return (
              <Pressable
                key={a.id}
                onPress={() => router.push(`/account/${a.id}`)}
                style={({ pressed }) => [styles.acct, pressed && PRESSED]}
              >
                <View style={[styles.acctChip, { backgroundColor: tint(color, 0.15) }]}><Icon name="bank" size={22} color={color} /></View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.acctName}>{a.name}</Text>
                  <Text style={styles.acctSub}>{subtitle}</Text>
                </View>
                {bal ? (
                  <Text style={[styles.acctBal, { color: bal.amount < 0 ? C.bad : C.good }]} numberOfLines={1} adjustsFontSizeToFit>{fmtBalance(bal.amount)}</Text>
                ) : (
                  <Text style={styles.acctBalPending}>—</Text>
                )}
              </Pressable>
            );
          })}
        </View>
      )}
    </ScrollChromeHeader>
  );
}

const styles = StyleSheet.create({
  acct: { flexDirection: 'row', alignItems: 'center', gap: 13, backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 16, padding: 15, paddingHorizontal: 16, marginBottom: 10 },
  acctChip: { width: 42, height: 42, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  acctName: { fontFamily: FONT.body, fontSize: 15, fontWeight: '600', color: C.textBright },
  acctSub: { fontFamily: FONT.body, fontSize: 12.5, color: C.textDim, marginTop: 2 },
  // Capped so a big balance shrinks instead of squeezing the name (large text).
  acctBal: { fontFamily: FONT.display, fontSize: 16, fontWeight: '700', letterSpacing: -0.3, maxWidth: '45%' },
  acctBalPending: { fontFamily: FONT.display, fontSize: 16, fontWeight: '700', color: C.textFaint },
});
