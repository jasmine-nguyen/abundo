import React from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, FONT, fmt } from '../../src/theme';
import { categoryTransactions, cycleWindow } from '../../src/context';
import { useCategoryTransactionsScreenData } from '../../src/queries';
import { Header } from '../../src/components/Header';
import { TransactionRow } from '../../src/components/TransactionRow';
import { DetailStates } from '../../src/components/DetailStates';

// WHIT-308: the category drill-in. Reached by tapping a spend row on the Insights tab; `id` is
// the category id (or UNCATEGORIZED_KEY for the "?" bucket) and `cycle` is which pay cycle the
// row was showing (0 = this, 1 = last). Transactions come from the SAME cached list the tabs
// use (no new endpoint) — we filter to this category over the cycle's window so the header
// total reconciles with the number on the Insights card.
export default function CategoryDetail() {
  const insets = useSafeAreaInsets();
  const { id, cycle } = useLocalSearchParams<{ id: string; cycle?: string }>();
  const { transactions, category, payCycle, isLoading, isError, payCycleError, refetch } = useCategoryTransactionsScreenData();
  const cycleNum = Number(cycle) || 0; // 0 = this cycle, 1 = last (what Insights pushes)
  // A first-load pay-cycle failure means the window is untrustworthy, so the filtered list
  // would cover the wrong dates — treat it as an error rather than showing a wrong list.
  const window = cycleWindow(payCycle, cycleNum);
  const detail = payCycleError ? null : categoryTransactions({ transactions, category }, id, window);

  return (
    <View style={{ flex: 1, paddingTop: insets.top + 6 }}>
      <Header title={detail?.name ?? 'Category'} />
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: insets.bottom + 30 }}
        showsVerticalScrollIndicator={false}
      >
        <DetailStates
          isLoading={isLoading}
          isError={isError || payCycleError}
          hasCache={transactions.length > 0 && !payCycleError}
          idPrefix="category"
          errorText="Couldn't load your transactions."
          retryLabel="Retry loading this category"
          onRetry={refetch}
        >
          {detail ? (
            <>
              <View testID="category-total" style={styles.totalCard}>
                <Text style={styles.totalLabel}>{cycleNum === 0 ? 'Spent this cycle' : 'Spent last cycle'}</Text>
                <Text style={styles.totalAmount}>{fmt(detail.total)}</Text>
                {detail.pending > 0 && <Text style={styles.totalPending}>{fmt(detail.pending)} pending</Text>}
              </View>
              <Text style={styles.count}>{detail.count} {detail.count === 1 ? 'transaction' : 'transactions'}</Text>
              {detail.groups.map((g) => (
                <View key={g.label} style={{ marginTop: 14 }}>
                  <Text style={styles.groupLabel}>{g.label}</Text>
                  {g.items.map((t) => <TransactionRow key={t.transaction_id} t={t} category={category} />)}
                </View>
              ))}
            </>
          ) : (
            // No transaction in this category this cycle (or a stale deep-link) — settled, not loading.
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>No transactions</Text>
              <Text style={styles.emptySub}>Nothing in this category for the selected cycle.</Text>
            </View>
          )}
        </DetailStates>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  totalCard: { backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 18, padding: 18, marginTop: 6 },
  totalLabel: { fontFamily: FONT.body, fontSize: 12.5, fontWeight: '600', color: C.textMid, letterSpacing: 0.2 },
  totalAmount: { fontFamily: FONT.display, fontSize: 30, fontWeight: '800', color: C.textBright, letterSpacing: -0.6, marginTop: 4 },
  totalPending: { fontFamily: FONT.body, fontSize: 13, color: C.textDim, marginTop: 6 },

  count: { fontFamily: FONT.body, fontSize: 13, color: C.textDim, marginTop: 16, marginHorizontal: 4 },
  groupLabel: { fontFamily: FONT.body, fontSize: 13, fontWeight: '700', color: C.textMid, letterSpacing: 0.2, marginHorizontal: 4, marginBottom: 4 },

  empty: { alignItems: 'center', paddingVertical: 64, paddingHorizontal: 30 },
  emptyTitle: { fontFamily: FONT.display, fontSize: 18, fontWeight: '700', color: C.textBright },
  emptySub: { fontFamily: FONT.body, fontSize: 13.5, color: C.textDim, marginTop: 6, textAlign: 'center', lineHeight: 20 },
});
