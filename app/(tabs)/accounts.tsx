import React, { useCallback } from 'react';
import { RefreshControl, View, Text, Pressable, StyleSheet } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { C, FONT, tint, fmtBalance, ACCOUNT_ACCENTS } from '../../src/theme';
import { Icon, Glyph } from '../../src/icons';
import { accountSummaries, useAppContext } from '../../src/context';
import { useTransactionsScreenData } from '../../src/queries';
import { usePullToRefresh } from '../../src/hooks/usePullToRefresh';
import { ScrollChromeHeader } from '../../src/motion/ScrollChromeHeader';
import { ListStates } from '../../src/components/ListStates';
import { SettingsButton } from '../../src/components/SettingsButton';

// The Accounts tab. Lifted out of the Transactions segmented control into its own bottom-bar
// tab, unchanged: it derives one card per account_id from the same transactions query the
// Transactions tab uses, shows live balances (poller-fed), and taps through to /account/[id].
export default function Accounts() {
  const router = useRouter();
  const { showToast } = useAppContext();
  // Same data source as the old segment — the all-accounts cursor feed — so behaviour and the
  // cold-load/error states are identical to before the move.
  const { transactions, balances, isLoading, isError, refetch, refetchStale, refetchList, refreshLiveBalances } = useTransactionsScreenData();
  useFocusEffect(useCallback(() => { refetchStale(); }, [refetchStale]));

  // WHIT-215: derived from the transactions themselves (one card per account_id), not a
  // hardcoded list — so names always match what's in the data.
  const accounts = accountSummaries({ transactions });

  const showError = isError && transactions.length === 0;
  const showSpinner = !showError && isLoading && transactions.length === 0;
  // Pull-to-refresh (WHIT-489: shared hook): refresh the visible list AND fetch fresh account
  // balances live from the bank, with the WHIT-363 stuck-spinner invariant owned in one place.
  const { pulling, onRefresh } = usePullToRefresh(refetchList, refreshLiveBalances, showToast);

  return (
    <ScrollChromeHeader
      title="Accounts"
      left={<SettingsButton />}
      // Fill the viewport even with only a few cards, so the whole screen is a pull-to-refresh
      // target. Without this the content is shorter than the screen and the pull never catches
      // on a short account list (the tall Transactions list never hit this).
      contentContainerStyle={styles.fill}
      refreshControl={(headerHeight) => (
        <RefreshControl
          // Show the pull spinner for a user pull unless the cold-load spinner owns the screen
          // (WHIT-363: never double-spin). `!showSpinner` — not `transactions.length > 0` — so a
          // pull on the settled "No accounts yet" empty state still shows feedback, now that the
          // fill makes that short state pullable.
          refreshing={pulling && !showSpinner}
          onRefresh={onRefresh}
          tintColor={C.accent}
          progressViewOffset={headerHeight}
        />
      )}
    >
      <ListStates
        showSpinner={showSpinner}
        showError={showError}
        idPrefix="accounts"
        errorText="Couldn't load your accounts."
        retryLabel="Retry loading your accounts"
        onRetry={refetch}
      />

      {!showSpinner && !showError && accounts.length === 0 && (
        <View style={styles.empty}>
          <View style={styles.emptyIcon}><Glyph name="wallet" size={32} color={C.accentSoft} /></View>
          <Text style={styles.emptyTitle}>No accounts yet</Text>
          <Text style={styles.emptySub}>Your linked accounts show up here once transactions sync.</Text>
        </View>
      )}

      {!showSpinner && !showError && accounts.length > 0 && (
        <View style={{ marginTop: 14 }}>
          {accounts.map((a, i) => {
            const color = ACCOUNT_ACCENTS[i % ACCOUNT_ACCENTS.length];
            // WHIT-212: signed live balance from the poller-fed query — green when in credit,
            // red when owing. Absent until the account's first poll → a dim "—".
            const bal = balances.get(a.id);
            return (
              <Pressable
                key={a.id}
                onPress={() => router.push(`/account/${a.id}`)}
                style={({ pressed }) => [styles.acct, pressed && styles.acctPressed]}
              >
                <View style={[styles.acctChip, { backgroundColor: tint(color, 0.15) }]}><Icon name="bank" size={22} color={color} /></View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.acctName}>{a.name}</Text>
                  <Text style={styles.acctSub}>{a.count} {a.count === 1 ? 'transaction' : 'transactions'}</Text>
                </View>
                {bal ? (
                  <Text style={[styles.acctBal, { color: bal.amount < 0 ? C.bad : C.good }]}>{fmtBalance(bal.amount)}</Text>
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
  // Stretch the scroll content to the viewport so a short account list is still one full-screen
  // pull-to-refresh surface (same idiom as budgets/goals styles.fill).
  fill: { flexGrow: 1 },
  empty: { alignItems: 'center', paddingVertical: 64, paddingHorizontal: 30 },
  emptyIcon: { width: 64, height: 64, borderRadius: 20, backgroundColor: tint(C.good, 0.12), alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
  emptyTitle: { fontFamily: FONT.display, fontSize: 18, fontWeight: '700', color: C.textBright },
  emptySub: { fontFamily: FONT.body, fontSize: 13.5, color: C.textDim, marginTop: 6, textAlign: 'center', lineHeight: 20 },

  acct: { flexDirection: 'row', alignItems: 'center', gap: 13, backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 16, padding: 15, paddingHorizontal: 16, marginBottom: 10 },
  acctPressed: { opacity: 0.6 },
  acctChip: { width: 42, height: 42, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  acctName: { fontFamily: FONT.body, fontSize: 15, fontWeight: '600', color: C.textBright },
  acctSub: { fontFamily: FONT.body, fontSize: 12.5, color: C.textDim, marginTop: 2 },
  acctBal: { fontFamily: FONT.display, fontSize: 16, fontWeight: '700', letterSpacing: -0.3 },
  acctBalPending: { fontFamily: FONT.display, fontSize: 16, fontWeight: '700', color: C.textFaint },
});
