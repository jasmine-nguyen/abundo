import React from 'react';
import { View, Text, StyleSheet, ScrollView, ActivityIndicator } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, FONT } from '../../src/theme';
import { transactionView } from '../../src/context';
import { formatDayMonthYear } from '../../src/dateutil';
import { useTransactionsScreenData } from '../../src/queries';
import { Header } from '../../src/components/Header';
import { Icon, Glyph } from '../../src/icons';
import { RetryButton } from '../../src/components/ui';

// WHIT-272: the per-transaction detail screen. Reached by the trailing chevron on a
// TransactionRow; the id in the route is the transaction_id. The transaction comes from the
// SAME cached query the lists use (no new endpoint) — we find it by id. This first slice is
// read-only (merchant/amount/date/account/category); the editable note + tags land next.
export default function TransactionDetail() {
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { transactions, category, isLoading, isError, refetch } = useTransactionsScreenData();
  const transaction = transactions.find((t) => t.transaction_id === id);
  const view = transaction ? transactionView({ category }, transaction) : null;

  // Cache-first, mirroring the account screen: only show the spinner/error when there is
  // NOTHING cached to render. A background refetch over cached rows keeps the detail up.
  const showSpinner = isLoading && transactions.length === 0;
  const showError = isError && transactions.length === 0;

  return (
    <View style={{ flex: 1, paddingTop: insets.top + 6 }}>
      <Header title="Transaction" />
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: insets.bottom + 30 }}
        showsVerticalScrollIndicator={false}
      >
        {showSpinner && (
          <View testID="transaction-loading" style={styles.state}>
            <ActivityIndicator color={C.accent} />
          </View>
        )}

        {showError && (
          <View testID="transaction-error" style={styles.state}>
            <Text style={styles.stateText}>Couldn't load this transaction.</Text>
            <RetryButton onPress={refetch} label="Retry loading this transaction" testID="transaction-retry" style={styles.retryBtn} textStyle={styles.retryText} />
          </View>
        )}

        {!showSpinner && !showError && transaction && view && (
          <>
            <View style={styles.hero}>
              <View style={[styles.chip, { backgroundColor: view.chipBg }]}>
                <Icon name={view.icon} size={30} color={view.iconColor} />
              </View>
              <Text style={styles.merchant} numberOfLines={2}>{view.merchant}</Text>
              <Text style={[styles.amount, { color: view.amountColor }]}>{view.amountLabel}</Text>
            </View>

            <View style={styles.card}>
              <Field label="Date" value={formatDayMonthYear(transaction.date)} />
              <Field label="Account" value={transaction.account_name} />
              <Field label="Category" value={view.categoryLabel} valueColor={view.categoryColor} />
              <Field label="Status" value={view.isPending ? 'Pending' : 'Posted'} last />
            </View>
          </>
        )}

        {/* No transaction carries this id (stale/unknown link) — settled, not loading. */}
        {!showSpinner && !showError && !transaction && (
          <View style={styles.empty}>
            <Glyph name="search" size={26} color={C.textFaint} />
            <Text style={styles.emptyTitle}>Transaction not found</Text>
            <Text style={styles.emptySub}>This transaction is no longer in your recent list.</Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function Field({ label, value, valueColor, last }: { label: string; value: string; valueColor?: string; last?: boolean }) {
  return (
    <View style={[styles.field, last && styles.fieldLast]}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={[styles.fieldValue, valueColor && { color: valueColor }]} numberOfLines={1}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  hero: { alignItems: 'center', paddingVertical: 22, gap: 10 },
  chip: { width: 60, height: 60, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  merchant: { fontFamily: FONT.display, fontSize: 22, fontWeight: '800', color: C.textBright, letterSpacing: -0.4, textAlign: 'center' },
  amount: { fontFamily: FONT.display, fontSize: 26, fontWeight: '800', letterSpacing: -0.5 },

  card: { backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 18, paddingHorizontal: 16, marginTop: 6 },
  field: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 15, borderBottomWidth: 1, borderBottomColor: C.hairline },
  fieldLast: { borderBottomWidth: 0 },
  fieldLabel: { fontFamily: FONT.body, fontSize: 13.5, color: C.textMid },
  fieldValue: { fontFamily: FONT.body, fontSize: 14.5, fontWeight: '600', color: C.textBright, flexShrink: 1, textAlign: 'right' },

  state: { alignItems: 'center', justifyContent: 'center', paddingVertical: 60, gap: 14 },
  stateText: { fontFamily: FONT.body, fontSize: 14.5, color: C.textMid, textAlign: 'center' },
  retryBtn: { paddingVertical: 10, paddingHorizontal: 22, borderRadius: 12, backgroundColor: 'rgba(124,140,255,.16)' },
  retryText: { fontFamily: FONT.body, fontSize: 14, fontWeight: '700', color: C.accentSoft },

  empty: { alignItems: 'center', paddingVertical: 64, paddingHorizontal: 30, gap: 8 },
  emptyTitle: { fontFamily: FONT.display, fontSize: 18, fontWeight: '700', color: C.textBright, marginTop: 4 },
  emptySub: { fontFamily: FONT.body, fontSize: 13.5, color: C.textDim, textAlign: 'center', lineHeight: 20 },
});
