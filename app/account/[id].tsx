import { useCallback, useMemo } from 'react';
import { View, Text, Pressable, StyleSheet, SectionList, RefreshControl } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, FONT, fmt, PRESSED } from '../../src/theme';
import { availableCredit, balanceDisplay } from '../../src/accountDisplay';
import { Glyph } from '../../src/icons';
import { accountDetail, accountNameFromId, useAppContext } from '../../src/context';
import { useAccountTransactionsScreenData, useRefreshLiveBalances } from '../../src/queries';
import { usePullToRefresh } from '../../src/hooks/usePullToRefresh';
import { syncBankTransactions } from '../../src/api';
import { LARGE_TEXT_MAX_SCALE } from '../../src/hooks/useLargeText';
import { useScrollEdge } from '../../src/hooks/useScrollEdge';
import { Header } from '../../src/components/Header';
import { DayHeading } from '../../src/components/DayHeading';
import { TransactionRow } from '../../src/components/TransactionRow';
import { LoadMoreButton } from '../../src/components/LoadMoreButton';
import { DetailStates } from '../../src/components/DetailStates';
import { EmptyState } from '../../src/components/EmptyState';
import { BalanceFreshnessPill } from '../../src/components/BalanceFreshnessPill';
import { isHomeLoanAccount } from '../../src/homeLoanAccount';
import { SECTION_LIST_FIRST_DRAW } from '../../src/motion/ScrollChromeHeader';
import type { Transaction } from '../../src/types';

// WHIT-215: the per-account transaction list. Reached from the Accounts tab; the id in the
// route is the account_id. ABU-67: the rows are this account's own paged history — the newest
// page first, Load More for older ones — grouped by date. WHIT-212: the live balance comes from
// the account-balances query (poller-fed), keyed by the same account_id.
// ABU-58: a SectionList, so only the rows on screen are drawn. The loading/error states, the
// balance card and the empty messages live in the list header, inside the pull-to-refresh scroller.
export default function AccountDetail() {
  const insets = useSafeAreaInsets();
  const edge = useScrollEdge();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { transactions, category, balances, isLoading, isError, refetch, hasMore, loadMore, isLoadingMore } = useAccountTransactionsScreenData(id);
  const { showToast } = useAppContext();
  const refreshLiveBalances = useRefreshLiveBalances();
  // ABU-66: the same pull as Accounts — re-read the list and fetch live balances.
  const { pulling, onRefresh } = usePullToRefresh(refetch, refreshLiveBalances, showToast, 'Balances up to date', syncBankTransactions);
  const detail = useMemo(() => accountDetail({ transactions, category }, id), [transactions, category, id]);
  const sections = useMemo(
    () => detail?.groups.map((g) => ({ key: g.label, dayTotal: g.dayTotal, data: g.items })) ?? [],
    [detail],
  );
  const bal = balances.get(id);
  const credit = availableCredit(bal);
  const display = bal ? balanceDisplay(bal.amount) : null;
  // WHIT-643: a balance-only account (no loaded transactions) is named from its id.
  let title = 'Account';
  if (bal) title = accountNameFromId(id);
  if (detail) title = detail.name;

  const renderSectionHeader = useCallback(({ section }: { section: { key: string; dayTotal: string | null } }) => (
    <View style={{ marginTop: 14 }}>
      <DayHeading label={section.key} dayTotal={section.dayTotal} />
    </View>
  ), []);
  const renderItem = useCallback(({ item }: { item: Transaction }) => <TransactionRow t={item} category={category} />, [category]);

  const header = (
    <DetailStates
      isLoading={isLoading}
      isError={isError}
      hasCache={transactions.length > 0}
      idPrefix="account"
      errorText="Couldn't load your transactions."
      retryLabel="Retry loading this account"
      onRetry={refetch}
    >
      {bal && display && (
        <View testID="account-balance" style={styles.balCard}>
          <Text style={styles.balLabel} maxFontSizeMultiplier={LARGE_TEXT_MAX_SCALE}>Current balance</Text>
          <Text
            style={[styles.balAmount, { color: display.color }]}
            numberOfLines={1}
            adjustsFontSizeToFit
            maxFontSizeMultiplier={LARGE_TEXT_MAX_SCALE}
          >
            {display.text}
          </Text>
          {display.owed && <Text style={styles.balOwed} maxFontSizeMultiplier={LARGE_TEXT_MAX_SCALE}>owed</Text>}
          {credit !== null && (
            <Text style={styles.balAvailable} maxFontSizeMultiplier={LARGE_TEXT_MAX_SCALE}>{fmt(credit)} available</Text>
          )}
          <BalanceFreshnessPill asOf={bal.as_of} tone="card" />
        </View>
      )}
      {/* ABU-64: the home loan opens into its payoff progress on the Home loan screen. */}
      {isHomeLoanAccount(bal) && (
        <Pressable
          testID="account-payoff-link"
          accessibilityRole="button"
          onPress={() => router.push('/mortgage')}
          style={({ pressed }) => [styles.payoffLink, pressed && PRESSED]}
        >
          <Text style={styles.payoffText} maxFontSizeMultiplier={LARGE_TEXT_MAX_SCALE}>See payoff progress</Text>
          <Glyph name="chevron" size={16} color={C.textFaint} />
        </Pressable>
      )}
      {/* WHIT-643: a saved balance but no transactions at all — a quiet account. */}
      {!detail && bal && <Text style={styles.quiet} maxFontSizeMultiplier={LARGE_TEXT_MAX_SCALE}>No transactions yet</Text>}
      {!detail && !bal && (
        // No transaction or balance carries this id (unknown/stale account) — settled, not loading.
        <EmptyState title="No transactions" sub="This account has no transactions yet." />
      )}
    </DetailStates>
  );

  return (
    <View style={{ flex: 1, paddingTop: insets.top + 6 }}>
      <Header title={title} divider={edge.scrolled} />
      <SectionList
        {...edge.scrollProps}
        style={{ flex: 1 }}
        sections={sections}
        keyExtractor={(t) => t.transaction_id}
        renderSectionHeader={renderSectionHeader}
        renderItem={renderItem}
        ListHeaderComponent={header}
        ListFooterComponent={detail && hasMore ? (
          <LoadMoreButton
            testID="account-load-more"
            onPress={loadMore}
            loading={isLoadingMore}
            accessibilityLabel="Load older transactions for this account"
          />
        ) : undefined}
        initialNumToRender={SECTION_LIST_FIRST_DRAW}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: insets.bottom + 30 }}
        showsVerticalScrollIndicator={false}
        // WHIT-363: never double-spin — the cold-load spinner owns an empty first load.
        refreshControl={<RefreshControl refreshing={pulling && !(isLoading && transactions.length === 0)} onRefresh={onRefresh} tintColor={C.accent} />}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  balCard: { backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 18, padding: 18, marginTop: 6 },
  balLabel: { fontFamily: FONT.body, fontSize: 12.5, fontWeight: '600', color: C.textMid, letterSpacing: 0.2 },
  balAmount: { fontFamily: FONT.display, fontSize: 30, fontWeight: '800', letterSpacing: -0.6, marginTop: 4 },
  balOwed: { fontFamily: FONT.body, fontSize: 13, color: C.textDim, marginTop: 2 },
  balAvailable: { fontFamily: FONT.body, fontSize: 13, color: C.textDim, marginTop: 6 },
  payoffLink: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 16, padding: 15, paddingHorizontal: 16, marginTop: 10 },
  payoffText: { fontFamily: FONT.body, fontSize: 15, fontWeight: '600', color: C.textBright },

  quiet: { fontFamily: FONT.body, fontSize: 13, color: C.textDim, marginTop: 16, marginHorizontal: 4 },});
