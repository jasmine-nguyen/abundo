import React, { useCallback, useState } from 'react';
import { RefreshControl, View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { C, FONT, tint, fmtBalance } from '../../src/theme';
import { Icon, Glyph } from '../../src/icons';
import { transactionGroups, countUncategorized, accountSummaries } from '../../src/context';
import { useTransactionsScreenData } from '../../src/queries';
import { ScrollChromeHeader } from '../../src/motion/ScrollChromeHeader';
import { TransactionRow } from '../../src/components/TransactionRow';
import { RetryButton } from '../../src/components/ui';

type Tab = 'all' | 'uncategorized' | 'accounts';

// Accounts carry no server-side icon/colour, so give each card a stable cosmetic accent by
// index — purely visual, no meaning attached to the colour (WHIT-215).
const ACCT_COLORS = ['#7FD49B', '#8AB4F8', '#F0B67F', '#C9B3F5', '#F08C8C'];

export default function Transactions() {
  const [tab, setTab] = useState<Tab>('all');
  const router = useRouter();
  // WHIT-190a: transactions now come from the cached, auth-gated query layer.
  const { transactions, category, balances, isLoading, isError, isFetching, refetch, refetchStale } = useTransactionsScreenData();
  useFocusEffect(useCallback(() => { refetchStale(); }, [refetchStale]));

  const view = { transactions, category };
  const uncategorizedCount = countUncategorized(view);
  const groups = transactionGroups(view, tab === 'uncategorized' ? 'uncategorized' : 'all');
  // WHIT-215: the Accounts tab is derived from the transactions themselves (one card per
  // account_id), not a hardcoded list — so names always match what's in the data.
  const accounts = accountSummaries(view);

  const showError = isError && transactions.length === 0;
  const showSpinner = !showError && isLoading && transactions.length === 0;
  // WHIT-192: pull-to-refresh re-fetches the visible transaction list. The other screens'
  // reads (budgets, loan, rules, pay-cycle) each refresh themselves on focus via their own
  // queries — pull no longer eagerly reloads the whole app off the retired store.
  const onRefresh = useCallback(() => { refetch(); }, [refetch]);

  // Scroll-to-hide chrome + the floating header now live in the shared ScrollChromeHeader
  // wrapper (WHIT-199). The RefreshControl is a render-prop so this screen keeps its own
  // refreshing/onRefresh state while the wrapper hands back headerHeight for the spinner
  // offset (WHIT-211 — otherwise the spinner draws behind the opaque floating header).
  return (
    <ScrollChromeHeader
      title="Transactions"
      right={<View style={styles.searchBtn}><Glyph name="search" size={20} color={C.textMid} /></View>}
      refreshControl={(headerHeight) => (
        <RefreshControl
          // Spin only while refreshing data we ALREADY have — the inline spinner owns
          // the cold-load state, so the two don't both spin at once (code-critic).
          refreshing={isFetching && transactions.length > 0}
          onRefresh={onRefresh}
          tintColor={C.accent}
          progressViewOffset={headerHeight}
        />
      )}
    >
        {/* segmented control */}
        <View style={styles.seg}>
          <Seg label="All" active={tab === 'all'} onPress={() => setTab('all')} flex={1} />
          <Seg label="Uncategorized" active={tab === 'uncategorized'} onPress={() => setTab('uncategorized')} flex={1.45} badge={uncategorizedCount} />
          <Seg label="Accounts" active={tab === 'accounts'} onPress={() => setTab('accounts')} flex={1} />
        </View>

        {tab !== 'accounts' && (
          <View style={styles.search}>
            <Glyph name="search" size={18} color="#6e6e78" />
            <Text style={styles.searchText}>Search transactions</Text>
          </View>
        )}

        {tab === 'uncategorized' && uncategorizedCount > 0 && (
          <View style={styles.hint}>
            <Glyph name="star" size={18} color={C.accentSoft} />
            <Text style={styles.hintText}>
              Tap a transaction to categorize it — and choose whether the call applies to{' '}
              <Text style={styles.hintBold}>just that one</Text> or <Text style={styles.hintBold}>every charge</Text> from that merchant.
            </Text>
          </View>
        )}

        {/* WHIT-215: the Accounts tab now derives from the transactions query too, so the
            cold-load spinner + error apply to every tab (they no longer skip 'accounts'). */}
        {showSpinner && (
          <View testID="transactions-loading" style={styles.rowsState}>
            <ActivityIndicator color={C.accent} />
          </View>
        )}
        {showError && (
          <View testID="transactions-error" style={styles.rowsState}>
            <Text style={styles.stateText}>Couldn't load your transactions.</Text>
            <RetryButton onPress={refetch} label="Retry loading your transactions" testID="transactions-retry" style={styles.retryBtn} textStyle={styles.retryText} />
          </View>
        )}

        {tab !== 'accounts' && !showSpinner && !showError && groups.map((g) => (
          <View key={g.label} style={{ marginTop: 18 }}>
            <Text style={styles.groupLabel}>{g.label}</Text>
            {g.items.map((t) => <TransactionRow key={t.transaction_id} t={t} category={category} />)}
          </View>
        ))}

        {tab === 'uncategorized' && !showSpinner && !showError && uncategorizedCount === 0 && (
          <View style={styles.empty}>
            <View style={styles.emptyIcon}><Glyph name="check" size={32} color={C.good} /></View>
            <Text style={styles.emptyTitle}>All caught up</Text>
            <Text style={styles.emptySub}>Every transaction is categorized. New ones matching your rules file themselves automatically.</Text>
          </View>
        )}

        {tab === 'accounts' && !showSpinner && !showError && accounts.length === 0 && (
          <View style={styles.empty}>
            <View style={styles.emptyIcon}><Glyph name="wallet" size={32} color={C.accentSoft} /></View>
            <Text style={styles.emptyTitle}>No accounts yet</Text>
            <Text style={styles.emptySub}>Your linked accounts show up here once transactions sync.</Text>
          </View>
        )}

        {tab === 'accounts' && !showSpinner && !showError && accounts.length > 0 && (
          <View style={{ marginTop: 14 }}>
            {accounts.map((a, i) => {
              const color = ACCT_COLORS[i % ACCT_COLORS.length];
              // WHIT-212: signed live balance from the poller-fed query — green when in
              // credit, red when owing. Absent until the account's first poll → a dim "—".
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

function Seg({ label, active, onPress, flex, badge }: { label: string; active: boolean; onPress: () => void; flex: number; badge?: number }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.segBtn, { flex, backgroundColor: active ? '#fff' : 'transparent' }, pressed && styles.segPressed]}>
      <Text style={[styles.segText, { color: active ? C.accentInk : C.textMid }]}>{label}</Text>
      {badge !== undefined && (
        <View style={[styles.badge, { backgroundColor: active ? tint(C.accentInk, 0.18) : tint(C.bad, 0.2) }]}>
          <Text style={[styles.badgeText, { color: active ? C.accentInk : C.badBright }]}>{badge}</Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  searchBtn: { width: 40, height: 40, backgroundColor: 'rgba(255,255,255,.06)', borderRadius: 12, alignItems: 'center', justifyContent: 'center' },

  seg: { flexDirection: 'row', gap: 4, padding: 4, backgroundColor: C.card, borderRadius: 14, marginBottom: 8 },
  segBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 9, borderRadius: 10 },
  // WHIT-184 taste: press feedback on the segmented control.
  segPressed: { opacity: 0.6 },
  segText: { fontFamily: FONT.body, fontSize: 12.5, fontWeight: '600' },
  badge: { minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 5, alignItems: 'center', justifyContent: 'center' },
  badgeText: { fontFamily: FONT.body, fontSize: 11, fontWeight: '700' },

  search: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 13, paddingVertical: 11, paddingHorizontal: 14, marginTop: 8 },
  searchText: { fontFamily: FONT.body, fontSize: 14, color: '#6e6e78' },

  hint: { flexDirection: 'row', gap: 11, alignItems: 'flex-start', backgroundColor: 'rgba(124,140,255,.1)', borderWidth: 1, borderColor: 'rgba(124,140,255,.22)', borderRadius: 16, padding: 13, paddingHorizontal: 14, marginTop: 10 },
  hintText: { flex: 1, fontFamily: FONT.body, fontSize: 12.5, color: C.accentSofter, lineHeight: 18 },
  hintBold: { color: '#fff', fontWeight: '700' },

  groupLabel: { fontFamily: FONT.body, fontSize: 13, fontWeight: '700', color: C.textMid, letterSpacing: 0.2, marginHorizontal: 4, marginBottom: 4 },

  empty: { alignItems: 'center', paddingVertical: 64, paddingHorizontal: 30 },
  emptyIcon: { width: 64, height: 64, borderRadius: 20, backgroundColor: tint(C.good, 0.12), alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
  emptyTitle: { fontFamily: FONT.display, fontSize: 18, fontWeight: '700', color: C.textBright },
  emptySub: { fontFamily: FONT.body, fontSize: 13.5, color: C.textDim, marginTop: 6, textAlign: 'center', lineHeight: 20 },

  acct: { flexDirection: 'row', alignItems: 'center', gap: 13, backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 16, padding: 15, paddingHorizontal: 16, marginBottom: 10 },
  // WHIT-215 taste: the account card is tappable now, so it dims on press like a row.
  acctPressed: { opacity: 0.6 },
  acctChip: { width: 42, height: 42, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  acctName: { fontFamily: FONT.body, fontSize: 15, fontWeight: '600', color: C.textBright },
  acctSub: { fontFamily: FONT.body, fontSize: 12.5, color: C.textDim, marginTop: 2 },
  acctBal: { fontFamily: FONT.display, fontSize: 16, fontWeight: '700', letterSpacing: -0.3 },
  acctBalPending: { fontFamily: FONT.display, fontSize: 16, fontWeight: '700', color: C.textFaint },

  rowsState: { alignItems: 'center', justifyContent: 'center', paddingVertical: 60, gap: 14 },
  stateText: { fontFamily: FONT.body, fontSize: 14.5, color: C.textMid, textAlign: 'center' },
  retryBtn: { paddingVertical: 10, paddingHorizontal: 22, borderRadius: 12, backgroundColor: 'rgba(124,140,255,.16)' },
  retryText: { fontFamily: FONT.body, fontSize: 14, fontWeight: '700', color: C.accentSoft },
});
