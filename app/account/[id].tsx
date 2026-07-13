import React from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, FONT, fmtBalance, fmt, agoLabel } from '../../src/theme';
import { accountDetail } from '../../src/context';
import { useTransactionsScreenData } from '../../src/queries';
import { Header } from '../../src/components/Header';
import { TransactionRow } from '../../src/components/TransactionRow';
import { DetailStates } from '../../src/components/DetailStates';

// WHIT-215: the per-account transaction list. Reached from the Accounts tab; the id in the
// route is the account_id. Transactions come from the SAME cached query the list uses (no
// new endpoint) — we filter to this account and group by date. WHIT-212: the live balance
// comes from the account-balances query (poller-fed), keyed by the same account_id.
export default function AccountDetail() {
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { transactions, category, balances, isLoading, isError, refetch } = useTransactionsScreenData();
  const detail = accountDetail({ transactions, category }, id);
  const bal = balances.get(id);
  // Show "available credit" only for a credit card: you OWE (amount < 0) yet have credit
  // left (available > 0). This excludes the loan (available 0) and spending (positive
  // amount) without relying on account_type, which the feed reports as "unknown" for cards.
  const showAvailable = bal != null && bal.amount < 0 && bal.available_balance != null && bal.available_balance > 0;

  return (
    <View style={{ flex: 1, paddingTop: insets.top + 6 }}>
      <Header title={detail?.name ?? 'Account'} />
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: insets.bottom + 30 }}
        showsVerticalScrollIndicator={false}
      >
        <DetailStates
          isLoading={isLoading}
          isError={isError}
          hasCache={transactions.length > 0}
          idPrefix="account"
          errorText="Couldn't load your transactions."
          retryLabel="Retry loading this account"
          onRetry={refetch}
        >
          {detail ? (
            <>
              {bal && (
                <View testID="account-balance" style={styles.balCard}>
                  <Text style={styles.balLabel}>Current balance</Text>
                  <Text style={[styles.balAmount, { color: bal.amount < 0 ? C.bad : C.good }]}>{fmtBalance(bal.amount)}</Text>
                  {showAvailable && (
                    <Text style={styles.balAvailable}>{fmt(bal.available_balance!)} available</Text>
                  )}
                  {!!agoLabel(bal.as_of) && <Text style={styles.balAsOf}>as of {agoLabel(bal.as_of)}</Text>}
                </View>
              )}
              <Text style={styles.count}>{detail.count} {detail.count === 1 ? 'transaction' : 'transactions'}</Text>
              {detail.groups.map((g) => (
                <View key={g.label} style={{ marginTop: 14 }}>
                  <Text style={styles.groupLabel}>{g.label}</Text>
                  {g.items.map((t) => <TransactionRow key={t.transaction_id} t={t} category={category} />)}
                </View>
              ))}
            </>
          ) : (
            // No transaction carries this id (unknown/stale account) — settled, not loading.
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>No transactions</Text>
              <Text style={styles.emptySub}>This account has no transactions yet.</Text>
            </View>
          )}
        </DetailStates>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  balCard: { backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 18, padding: 18, marginTop: 6 },
  balLabel: { fontFamily: FONT.body, fontSize: 12.5, fontWeight: '600', color: C.textMid, letterSpacing: 0.2 },
  balAmount: { fontFamily: FONT.display, fontSize: 30, fontWeight: '800', letterSpacing: -0.6, marginTop: 4 },
  balAvailable: { fontFamily: FONT.body, fontSize: 13, color: C.textDim, marginTop: 6 },
  balAsOf: { fontFamily: FONT.body, fontSize: 12, color: C.textFaint, marginTop: 2 },

  count: { fontFamily: FONT.body, fontSize: 13, color: C.textDim, marginTop: 16, marginHorizontal: 4 },
  groupLabel: { fontFamily: FONT.body, fontSize: 13, fontWeight: '700', color: C.textMid, letterSpacing: 0.2, marginHorizontal: 4, marginBottom: 4 },

  empty: { alignItems: 'center', paddingVertical: 64, paddingHorizontal: 30 },
  emptyTitle: { fontFamily: FONT.display, fontSize: 18, fontWeight: '700', color: C.textBright },
  emptySub: { fontFamily: FONT.body, fontSize: 13.5, color: C.textDim, marginTop: 6, textAlign: 'center', lineHeight: 20 },
});
