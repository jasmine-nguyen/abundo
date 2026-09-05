import React, { useCallback, useState } from 'react';
import { RefreshControl, View, Text, TextInput, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';
import { C, FONT, tint } from '../../src/theme';
import { Glyph } from '../../src/icons';
import { transactionGroups, transactionMatchesSearch, countUncategorized, useAppContext } from '../../src/context';
import { useTransactionsScreenData } from '../../src/queries';
import { ScrollChromeHeader } from '../../src/motion/ScrollChromeHeader';
import { TransactionRow } from '../../src/components/TransactionRow';
import { RetryButton } from '../../src/components/ui';
import { SettingsButton } from '../../src/components/SettingsButton';

type Tab = 'all' | 'uncategorized';

export default function Transactions() {
  const [tab, setTab] = useState<Tab>('all');
  const [search, setSearch] = useState('');
  const insets = useSafeAreaInsets();
  const { openMultiPicker, showToast } = useAppContext();
  // WHIT-190a: transactions now come from the cached, auth-gated query layer — an all-accounts
  // cursor feed, so `loadMore` pages older history in and `hasMore` is false at end-of-history.
  const { transactions, category, isLoading, isError, refetch, refetchStale, refetchList, refreshLiveBalances, hasMore, loadMore, isLoadingMore } = useTransactionsScreenData();
  useFocusEffect(useCallback(() => { refetchStale(); }, [refetchStale]));

  // WHIT-291: multi-select re-categorise. `selectionMode` swaps the rows for checkboxes; `selected`
  // holds the chosen ids. Exiting (Cancel, tab switch) clears the set. Tapping "Re-categorise"
  // captures the ids into the picker sheet (openMultiPicker) and leaves selection mode — cancelling
  // the picker returns to the normal list.
  const [selectionMode, setSelectionMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const exitSelection = useCallback(() => { setSelectionMode(false); setSelected(new Set()); }, []);
  const toggleSelect = useCallback((id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  }), []);
  // Switching between All and Uncategorized leaves selection mode, so a selection never
  // straddles a filter the user can no longer see.
  const changeTab = useCallback((t: Tab) => { setTab(t); exitSelection(); }, [exitSelection]);
  // Only carry ids still in the live list — a background refetch (pull-to-refresh) can evict a
  // selected charge mid-selection, and this keeps the picker's "File N" count honest.
  const onRecategorize = () => {
    const live = new Set(transactions.map((t) => t.transaction_id));
    openMultiPicker([...selected].filter((id) => live.has(id)));
    exitSelection();
  };

  const view = { transactions, category };
  const uncategorizedCount = countUncategorized(view);
  // Live search over the visible fields (merchant + category + amount). Filtered before grouping
  // so the date sections only show matching rows. Empty query → the full list (no-op filter).
  const query = search.trim();
  const searched = query ? transactions.filter((t) => transactionMatchesSearch({ category }, t, query)) : transactions;
  const groups = transactionGroups({ transactions: searched, category }, tab === 'uncategorized' ? 'uncategorized' : 'all');

  const showError = isError && transactions.length === 0;
  const showSpinner = !showError && isLoading && transactions.length === 0;
  // Pull-to-refresh: refresh the visible list AND fetch fresh account balances live from the
  // bank (refreshLiveBalances). The other screens (budgets, loan, rules, pay-cycle) refresh
  // themselves on focus via their own queries — pull doesn't reload the whole app.
  // WHIT-363: the spinner must show ONLY for a real finger-pull and must always dismiss. The
  // local `pulling` flag owns it, set on the pull and cleared in a `.finally()` once BOTH the
  // list refetch and the live balance call SETTLE — success, failure, or timeout. It is NEVER
  // driven off isFetching (that was the WHIT-363 stuck-spinner cause), so the on-focus
  // background refetch never raises it and a slow/failed live call can't wedge it.
  const [pulling, setPulling] = useState(false);
  const onRefresh = useCallback(() => {
    setPulling(true);
    // A failed live refresh keeps the last-good balances; just tell the user, don't blank the list.
    const livePull = refreshLiveBalances()
      .catch(() => showToast('Could not refresh balances. Showing last saved.'));
    Promise.allSettled([refetchList(), livePull]).finally(() => setPulling(false));
  }, [refetchList, refreshLiveBalances, showToast]);

  // Scroll-to-hide chrome + the floating header now live in the shared ScrollChromeHeader
  // wrapper (WHIT-199). The RefreshControl is a render-prop so this screen keeps its own
  // refreshing/onRefresh state while the wrapper hands back headerHeight for the spinner
  // offset (WHIT-211 — otherwise the spinner draws behind the opaque floating header).
  // WHIT-291: a "Select" button enters selection mode; it becomes "Cancel" while selecting.
  const headerRight = selectionMode ? (
    <Pressable onPress={exitSelection} hitSlop={8} style={styles.hdrBtn} accessibilityRole="button">
      <Text style={styles.hdrBtnText}>Cancel</Text>
    </Pressable>
  ) : (
    <Pressable onPress={() => { setSelectionMode(true); setSearch(''); }} hitSlop={8} style={styles.hdrBtn} accessibilityRole="button">
      <Text style={styles.hdrBtnText}>Select</Text>
    </Pressable>
  );

  return (
    <View style={{ flex: 1 }}>
    <ScrollChromeHeader
      title="Transactions"
      left={<SettingsButton />}
      right={headerRight}
      contentContainerStyle={selectionMode ? styles.contentWithBar : undefined}
      keyboardShouldPersistTaps="handled"
      refreshControl={(headerHeight) => (
        <RefreshControl
          // WHIT-363: the pull spinner shows only for a user pull (`pulling`), cleared when that
          // pull's fetch ends — so the silent on-focus/background refetch never raises it. The
          // `length > 0` guard stops a pull during the cold-load window from double-spinning with
          // the inline loading spinner (showSpinner), which owns the empty first-load state.
          refreshing={pulling && transactions.length > 0}
          onRefresh={onRefresh}
          tintColor={C.accent}
          progressViewOffset={headerHeight}
        />
      )}
    >
        {/* segmented control */}
        <View style={styles.seg}>
          <Seg label="All" active={tab === 'all'} onPress={() => changeTab('all')} flex={1} />
          <Seg label="Uncategorized" active={tab === 'uncategorized'} onPress={() => changeTab('uncategorized')} flex={1.45} badge={uncategorizedCount} />
        </View>

        {!selectionMode && (
          <View style={styles.search}>
            <Glyph name="search" size={18} color="#6e6e78" />
            <TextInput
              value={search}
              onChangeText={setSearch}
              placeholder="Search transactions"
              placeholderTextColor="#6e6e78"
              style={styles.searchInput}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              accessibilityLabel="Search transactions"
            />
            {search.length > 0 && (
              <Pressable onPress={() => setSearch('')} hitSlop={10} accessibilityRole="button" accessibilityLabel="Clear search">
                <Text style={styles.searchClear}>✕</Text>
              </Pressable>
            )}
          </View>
        )}

        {tab === 'uncategorized' && uncategorizedCount > 0 && !selectionMode && (
          <View style={styles.hint}>
            <Glyph name="star" size={18} color={C.accentSoft} />
            <Text style={styles.hintText}>
              Tap a transaction to categorize it — and choose whether the call applies to{' '}
              <Text style={styles.hintBold}>just that one</Text> or <Text style={styles.hintBold}>every charge</Text> from that merchant.
            </Text>
          </View>
        )}

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

        {!showSpinner && !showError && groups.map((g) => (
          <View key={g.label} style={{ marginTop: 18 }}>
            <Text style={styles.groupLabel}>{g.label}</Text>
            {g.items.map((t) => (
              <TransactionRow
                key={t.transaction_id}
                t={t}
                category={category}
                selectable={selectionMode}
                selected={selected.has(t.transaction_id)}
                onToggleSelect={() => toggleSelect(t.transaction_id)}
              />
            ))}
          </View>
        ))}

        {/* Search returned nothing on this tab (the "all caught up" state below still owns the
            genuinely-empty uncategorized case, so don't double up on it). */}
        {!showSpinner && !showError && query.length > 0 && groups.length === 0
          && !(tab === 'uncategorized' && uncategorizedCount === 0) && (
          <View testID="transactions-no-results" style={styles.empty}>
            <View style={[styles.emptyIcon, { backgroundColor: 'rgba(255,255,255,.06)' }]}><Glyph name="search" size={30} color={C.textDim} /></View>
            <Text style={styles.emptyTitle}>No matches</Text>
            <Text style={styles.emptySub}>No transactions match “{query}”.</Text>
          </View>
        )}

        {tab === 'uncategorized' && !showSpinner && !showError && uncategorizedCount === 0 && (
          <View style={styles.empty}>
            <View style={styles.emptyIcon}><Glyph name="check" size={32} color={C.good} /></View>
            <Text style={styles.emptyTitle}>All caught up</Text>
            <Text style={styles.emptySub}>Every transaction is categorized. New ones matching your rules file themselves automatically.</Text>
          </View>
        )}

        {/* Load More: page older history in via the feed cursor. Hidden at end-of-history
            (hasMore false) and while the cold-load spinner / error own the empty state. The
            newest batch shows first; each tap appends the next, older batch. */}
        {!showSpinner && !showError && hasMore && (
          isLoadingMore ? (
            <View testID="transactions-load-more-spinner" style={styles.loadMoreState}>
              <ActivityIndicator color={C.accent} />
            </View>
          ) : (
            <Pressable
              testID="transactions-load-more"
              onPress={loadMore}
              accessibilityRole="button"
              accessibilityLabel="Load older transactions"
              style={({ pressed }) => [styles.loadMore, pressed && styles.segPressed]}
            >
              <Text style={styles.loadMoreText}>Load More</Text>
            </Pressable>
          )
        )}

    </ScrollChromeHeader>
    {/* WHIT-291: the selection action bar floats above the tab bar while selecting. */}
    {selectionMode && (
      <View style={[styles.actionBar, { paddingBottom: insets.bottom + 12 }]}>
        <Text style={styles.actionCount}>{selected.size} selected</Text>
        <Pressable
          onPress={onRecategorize}
          disabled={selected.size === 0}
          accessibilityRole="button"
          accessibilityLabel="Re-categorize selected transactions"
          style={[styles.actionBtn, selected.size === 0 && styles.actionBtnDisabled]}
        >
          <Text style={[styles.actionBtnText, selected.size === 0 && styles.actionBtnTextDisabled]}>Re-categorize</Text>
        </Pressable>
      </View>
    )}
    </View>
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
  // WHIT-291: header Select/Cancel button.
  hdrBtn: { height: 40, paddingHorizontal: 8, alignItems: 'flex-end', justifyContent: 'center' },
  hdrBtnText: { fontFamily: FONT.body, fontSize: 14.5, fontWeight: '700', color: C.accentSoft },
  // Extra bottom padding so the last rows can scroll clear of the floating action bar.
  contentWithBar: { paddingBottom: 108 },
  actionBar: { position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingTop: 12, paddingHorizontal: 18, backgroundColor: '#161620', borderTopWidth: 1, borderTopColor: C.hairline },
  actionCount: { fontFamily: FONT.body, fontSize: 14.5, fontWeight: '600', color: C.textMid },
  actionBtn: { paddingVertical: 12, paddingHorizontal: 20, borderRadius: 13, backgroundColor: C.accent },
  actionBtnDisabled: { backgroundColor: tint(C.accentAlt, 0.22) },
  actionBtnText: { fontFamily: FONT.body, fontSize: 14.5, fontWeight: '700', color: C.accentInk },
  actionBtnTextDisabled: { color: '#6a6a90' },

  seg: { flexDirection: 'row', gap: 4, padding: 4, backgroundColor: C.card, borderRadius: 14, marginBottom: 8 },
  segBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 9, borderRadius: 10 },
  // WHIT-184 taste: press feedback on the segmented control.
  segPressed: { opacity: 0.6 },
  segText: { fontFamily: FONT.body, fontSize: 12.5, fontWeight: '600' },
  badge: { minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 5, alignItems: 'center', justifyContent: 'center' },
  badgeText: { fontFamily: FONT.body, fontSize: 11, fontWeight: '700' },

  search: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 13, paddingVertical: 4, paddingHorizontal: 14, marginTop: 8 },
  // The input carries its own vertical padding so the row height matches the old placeholder box.
  searchInput: { flex: 1, fontFamily: FONT.body, fontSize: 14, color: C.textBright, paddingVertical: 8, padding: 0 },
  searchClear: { fontFamily: FONT.body, fontSize: 15, fontWeight: '600', color: '#6e6e78', paddingHorizontal: 2 },

  hint: { flexDirection: 'row', gap: 11, alignItems: 'flex-start', backgroundColor: tint(C.accentAlt, 0.1), borderWidth: 1, borderColor: tint(C.accentAlt, 0.22), borderRadius: 16, padding: 13, paddingHorizontal: 14, marginTop: 10 },
  hintText: { flex: 1, fontFamily: FONT.body, fontSize: 12.5, color: C.accentSofter, lineHeight: 18 },
  hintBold: { color: '#fff', fontWeight: '700' },

  groupLabel: { fontFamily: FONT.body, fontSize: 13, fontWeight: '700', color: C.textMid, letterSpacing: 0.2, marginHorizontal: 4, marginBottom: 4 },

  empty: { alignItems: 'center', paddingVertical: 64, paddingHorizontal: 30 },
  emptyIcon: { width: 64, height: 64, borderRadius: 20, backgroundColor: tint(C.good, 0.12), alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
  emptyTitle: { fontFamily: FONT.display, fontSize: 18, fontWeight: '700', color: C.textBright },
  emptySub: { fontFamily: FONT.body, fontSize: 13.5, color: C.textDim, marginTop: 6, textAlign: 'center', lineHeight: 20 },

  // Load More: same treatment as the budget-detail reveal button (app/budget/[id]), plus a
  // matched-height spinner slot so the list doesn't jump when it swaps in while a page loads.
  loadMore: { marginTop: 18, paddingVertical: 12, borderRadius: 13, borderWidth: 1, borderColor: C.hairline, alignItems: 'center' },
  loadMoreText: { fontFamily: FONT.body, fontSize: 14, fontWeight: '600', color: C.accentSoft },
  loadMoreState: { marginTop: 18, paddingVertical: 12, alignItems: 'center', justifyContent: 'center' },

  rowsState: { alignItems: 'center', justifyContent: 'center', paddingVertical: 60, gap: 14 },
  stateText: { fontFamily: FONT.body, fontSize: 14.5, color: C.textMid, textAlign: 'center' },
  retryBtn: { paddingVertical: 10, paddingHorizontal: 22, borderRadius: 12, backgroundColor: tint(C.accentAlt, 0.16) },
  retryText: { fontFamily: FONT.body, fontSize: 14, fontWeight: '700', color: C.accentSoft },
});
