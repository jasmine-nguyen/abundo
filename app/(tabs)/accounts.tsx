import { useCallback } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { C, FONT, tint, PRESSED } from '../../src/theme';
import { Glyph } from '../../src/icons';
import { accountSummaries, useAppContext } from '../../src/context';
import { useTransactionsScreenData, useHomeLoanProgress } from '../../src/queries';
import { isHomeLoanAccount } from '../../src/homeLoanAccount';
import { orderAccounts, accountAccent, accountKind, accountSubtitle, balanceDisplay, ACCOUNT_KIND_ICON } from '../../src/accountDisplay';
import { usePullToRefresh } from '../../src/hooks/usePullToRefresh';
import { LARGE_TEXT_MAX_SCALE, useLargeText } from '../../src/hooks/useLargeText';
import { ScrollChromeHeader } from '../../src/motion/ScrollChromeHeader';
import { ListStates, StaleDataLine } from '../../src/components/ListStates';
import { EmptyState } from '../../src/components/EmptyState';
import { StackingRowHeader } from '../../src/components/StackingRowHeader';

// The Accounts tab. Lifted out of the Transactions segmented control into its own bottom-bar
// tab: it derives one card per account_id from the same transactions query the Transactions
// tab uses plus the saved balances, shows live balances (poller-fed), and taps through to
// /account/[id].
export default function Accounts() {
  const router = useRouter();
  const { showToast } = useAppContext();
  const large = useLargeText();
  // Same data source as the old segment — the all-accounts cursor feed — so behaviour and the
  // cold-load/error states are identical to before the move.
  const { transactions, balances, isLoading, isError, error, refreshError, updatedAt, bankSynced, refetch, refetchStale, refetchList, refreshLiveBalances } = useTransactionsScreenData();
  useFocusEffect(useCallback(() => { refetchStale(); }, [refetchStale]));

  // WHIT-215: derived from the transactions themselves (one card per account_id), not a
  // hardcoded list — so names always match what's in the data. WHIT-643: plus every account
  // with a saved balance, so a quiet account (the home loan) still gets a card. ABU-65: a fixed
  // order by account type (cards → everyday → home loan), so a busy day never reshuffles them.
  const accounts = orderAccounts(accountSummaries({ transactions }, balances.keys()), balances);
  const loanLine = useHomeLoanProgress([...balances.values()].some(isHomeLoanAccount));

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
      subtitle={showError ? null : <StaleDataLine idPrefix="accounts" error={refreshError} updatedAt={updatedAt} showUpdated bankSynced={bankSynced} />}
      // Show the pull spinner for a user pull unless the cold-load spinner owns the screen
      // (WHIT-363: never double-spin). `!showSpinner` — not `transactions.length > 0` — so a
      // pull on the settled "No accounts yet" empty state still shows feedback, now that the
      // header's full-height content makes that short state pullable.
      refreshing={pulling && !showSpinner}
      onRefresh={onRefresh}
    >
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
          {accounts.map((a) => {
            const color = accountAccent(a.id);
            // WHIT-212: the live balance from the poller-fed query. Absent until the account's
            // first poll → a dim "—".
            const bal = balances.get(a.id);
            const subtitle = accountSubtitle({ summary: a, bal, loanLine });
            const display = bal ? balanceDisplay(bal.amount) : null;
            let balanceLabel = 'balance not loaded yet';
            if (display) balanceLabel = `${display.text}${display.owed ? ' owed' : ''}`;
            return (
              <Pressable
                key={a.id}
                accessibilityRole="button"
                accessibilityLabel={`${a.name}, ${balanceLabel}, ${subtitle}`}
                onPress={() => router.push(`/account/${a.id}`)}
                style={({ pressed }) => [styles.acct, pressed && PRESSED]}
              >
                <StackingRowHeader
                  icon={ACCOUNT_KIND_ICON[accountKind(bal)]}
                  color={color}
                  chipBg={tint(color, 0.15)}
                  centered
                  name={<Text style={styles.acctName} numberOfLines={large ? undefined : 2} maxFontSizeMultiplier={LARGE_TEXT_MAX_SCALE}>{a.name}</Text>}
                  sub={<Text style={styles.acctSub} maxFontSizeMultiplier={LARGE_TEXT_MAX_SCALE}>{subtitle}</Text>}
                  right={display ? (
                    <>
                      <Text style={[styles.acctBal, { color: display.color }]} numberOfLines={1} adjustsFontSizeToFit maxFontSizeMultiplier={LARGE_TEXT_MAX_SCALE}>{display.text}</Text>
                      {display.owed && <Text style={styles.acctOwed} maxFontSizeMultiplier={LARGE_TEXT_MAX_SCALE}>owed</Text>}
                    </>
                  ) : (
                    <Text style={styles.acctBalPending} accessibilityLabel="Balance not loaded yet" maxFontSizeMultiplier={LARGE_TEXT_MAX_SCALE}>—</Text>
                  )}
                />
              </Pressable>
            );
          })}
        </View>
      )}
    </ScrollChromeHeader>
  );
}

const styles = StyleSheet.create({
  acct: { backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 16, padding: 15, paddingHorizontal: 16, marginBottom: 10 },
  acctName: { fontFamily: FONT.body, fontSize: 15, fontWeight: '600', color: C.textBright },
  acctSub: { fontFamily: FONT.body, fontSize: 12.5, color: C.textDim, marginTop: 2 },
  acctBal: { fontFamily: FONT.display, fontSize: 16, fontWeight: '700', letterSpacing: -0.3 },
  acctOwed: { fontFamily: FONT.body, fontSize: 11, color: C.textDim, marginTop: 1 },
  acctBalPending: { fontFamily: FONT.display, fontSize: 16, fontWeight: '700', color: C.textFaint },
});
