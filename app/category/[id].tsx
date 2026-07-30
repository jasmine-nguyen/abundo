import React from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, FONT, fmt } from '../../src/theme';
import { categoryTransactions } from '../../src/context';
import { useCategoryTransactionsScreenData } from '../../src/queries';
import { Header } from '../../src/components/Header';
import { TransactionRow } from '../../src/components/TransactionRow';
import { DetailStates } from '../../src/components/DetailStates';

// WHIT-308/WHIT-342: the category drill-in. Reached by tapping a spend row on the Insights tab;
// `id` is the category id (or UNCATEGORIZED_KEY for the "?" bucket) and `cycle` is which pay
// cycle the row was showing (0 = this, 1 = last). The transactions are fetched server-side for
// that category + cycle (/categories/{id}/transactions), over the SAME window as the Insights
// card, so the header total reconciles with it.
export default function CategoryDetail() {
  const insets = useSafeAreaInsets();
  const { id, cycle } = useLocalSearchParams<{ id: string; cycle?: string }>();
  // 0 = this cycle, 1 = last (the only values Insights pushes). Floor + clamp to the integer set
  // {0,1} so a stale or hand-edited deep-link (?cycle=2, ?cycle=-1, ?cycle=0.5) can't request an
  // older window or mislabel it — cycleNum is a discrete cycle index, so it must be whole (WHIT-309).
  const cycleNum = Math.min(1, Math.max(0, Math.floor(Number(cycle) || 0)));
  const { transactions, category, categoriesReady, isLoading, isError, refetch } = useCategoryTransactionsScreenData(id, cycleNum);
  const detail = categoryTransactions({ transactions, category }, id);
  // WHIT-366: an Income-bucket category reached from the Earned drill reads "Earned", not "Spent".
  const isIncome = category(id)?.bucket === 'Income';
  const verb = isIncome ? 'Earned' : 'Spent';

  return (
    <View style={{ flex: 1, paddingTop: insets.top + 6 }}>
      <Header title={detail?.name ?? 'Category'} />
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: insets.bottom + 30 }}
        showsVerticalScrollIndicator={false}
      >
        <DetailStates
          isLoading={isLoading}
          isError={isError}
          // WHIT-367: the detail needs the taxonomy to label rows/icons and pick the income-vs-spend
          // sign, so "have cache" means BOTH transactions AND categories are loaded. Without the
          // categoriesReady half, a cold taxonomy renders an income drill as "Spent $0" with grey
          // rows for a beat; gating here shows the spinner until the taxonomy is ready instead.
          hasCache={transactions.length > 0 && categoriesReady}
          idPrefix="category"
          errorText="Couldn't load your transactions."
          retryLabel="Retry loading this category"
          onRetry={refetch}
        >
          {detail ? (
            <>
              <View testID="category-total" style={styles.totalCard}>
                <Text style={styles.totalLabel}>{verb} {cycleNum === 0 ? 'this cycle' : 'last cycle'}</Text>
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
