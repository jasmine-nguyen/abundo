import React from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView, ActivityIndicator } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, FONT } from '../../src/theme';
import { accountDetail } from '../../src/context';
import { useTransactionsScreenData } from '../../src/queries';
import { Header } from '../../src/components/Header';
import { TransactionRow } from '../../src/components/TransactionRow';

// WHIT-215: the per-account transaction list. Reached from the Accounts tab; the id in the
// route is the account_id. Everything comes from the SAME cached transactions query the
// list uses (no new endpoint) — we just filter to this account and group by date.
export default function AccountDetail() {
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { transactions, category, isLoading, isError, refetch } = useTransactionsScreenData();
  const detail = accountDetail({ transactions, category }, id);

  // Cache-first, mirroring the Transactions screen: only show the spinner/error when there
  // is NOTHING cached to render. A background refetch over cached rows keeps the list up.
  const showSpinner = isLoading && transactions.length === 0;
  const showError = isError && transactions.length === 0;

  return (
    <View style={{ flex: 1, paddingTop: insets.top + 6 }}>
      <Header title={detail?.name ?? 'Account'} />
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: insets.bottom + 30 }}
        showsVerticalScrollIndicator={false}
      >
        {showSpinner && (
          <View testID="account-loading" style={styles.state}>
            <ActivityIndicator color={C.accent} />
          </View>
        )}

        {showError && (
          <View testID="account-error" style={styles.state}>
            <Text style={styles.stateText}>Couldn't load your transactions.</Text>
            <Pressable testID="account-retry" onPress={refetch} style={styles.retryBtn}>
              <Text style={styles.retryText}>Retry</Text>
            </Pressable>
          </View>
        )}

        {!showSpinner && !showError && detail && (
          <>
            <Text style={styles.count}>{detail.count} {detail.count === 1 ? 'transaction' : 'transactions'}</Text>
            {detail.groups.map((g) => (
              <View key={g.label} style={{ marginTop: 14 }}>
                <Text style={styles.groupLabel}>{g.label}</Text>
                {g.items.map((t) => <TransactionRow key={t.transaction_id} t={t} category={category} />)}
              </View>
            ))}
          </>
        )}

        {/* No transaction carries this id (unknown/stale account) — settled, not loading. */}
        {!showSpinner && !showError && !detail && (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No transactions</Text>
            <Text style={styles.emptySub}>This account has no transactions yet.</Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  count: { fontFamily: FONT.body, fontSize: 13, color: C.textDim, marginTop: 6, marginHorizontal: 4 },
  groupLabel: { fontFamily: FONT.body, fontSize: 13, fontWeight: '700', color: C.textMid, letterSpacing: 0.2, marginHorizontal: 4, marginBottom: 4 },

  state: { alignItems: 'center', justifyContent: 'center', paddingVertical: 60, gap: 14 },
  stateText: { fontFamily: FONT.body, fontSize: 14.5, color: C.textMid, textAlign: 'center' },
  retryBtn: { paddingVertical: 10, paddingHorizontal: 22, borderRadius: 12, backgroundColor: 'rgba(124,140,255,.16)' },
  retryText: { fontFamily: FONT.body, fontSize: 14, fontWeight: '700', color: C.accentSoft },

  empty: { alignItems: 'center', paddingVertical: 64, paddingHorizontal: 30 },
  emptyTitle: { fontFamily: FONT.display, fontSize: 18, fontWeight: '700', color: C.textBright },
  emptySub: { fontFamily: FONT.body, fontSize: 13.5, color: C.textDim, marginTop: 6, textAlign: 'center', lineHeight: 20 },
});
