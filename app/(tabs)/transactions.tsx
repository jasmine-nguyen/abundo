import React, { useCallback, useEffect, useState } from 'react';
import { RefreshControl, View, Text, TextInput, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';
import { C, FONT, tint } from '../../src/theme';
import { Glyph } from '../../src/icons';
import { transactionGroups, transactionMatchesSearch, countUncategorized, unionById, useAppContext, SEARCH_QUERY_MAX_LEN } from '../../src/context';
import { useTransactionsScreenData, useUncategorizedCount, useUncategorizedMerchants } from '../../src/queries';
import { usePullToRefresh } from '../../src/hooks/usePullToRefresh';
import { useDebouncedValue } from '../../src/hooks/useDebouncedValue';
import { ScrollChromeHeader } from '../../src/motion/ScrollChromeHeader';
import { TransactionRow } from '../../src/components/TransactionRow';
import { ListStates } from '../../src/components/ListStates';
import { SettingsButton } from '../../src/components/SettingsButton';

type Tab = 'all' | 'uncategorized';

// WHIT-576: how long typing must pause before the full-history search asks the server.
const SEARCH_DEBOUNCE_MS = 300;

// A query of only `$` / `,` matches every row locally, so asking the server would just return the
// newest few hundred rows of everything.
function needsServerSearch(query: string): boolean {
  return query.replace(/[$,]/g, '').trim() !== '';
}

export default function Transactions() {
  const [tab, setTab] = useState<Tab>('all');
  const [search, setSearch] = useState('');
  const query = search.trim();
  // WHIT-576: the box searches ALL history on the server once typing pauses; until the server
  // answers, the loaded rows (and the previous answer) filter instantly by the live text below.
  const debouncedQuery = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);
  const serverQuery = needsServerSearch(debouncedQuery) ? debouncedQuery : '';
  const insets = useSafeAreaInsets();
  const { openMultiPicker, showToast, setSheet, pendingUncategorizedSelect, clearUncategorizedSelect } = useAppContext();
  // WHIT-190a: transactions now come from the cached, auth-gated query layer — an all-accounts
  // cursor feed, so `loadMore` pages older history in and `hasMore` is false at end-of-history.
  const { transactions, category, isLoading, isError, refetch, refetchStale, refetchList, refreshLiveBalances, hasMore, loadMore, isLoadingMore, search: serverSearch } = useTransactionsScreenData(tab, serverQuery);
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
  // WHIT-544: the "File by shop" leftover sheet asks (via the shared flag) to jump the user
  // straight into the Uncategorized list's multi-select. Set tab + selection mode DIRECTLY, not
  // via changeTab — changeTab calls exitSelection(), which would wipe the mode we're turning on.
  // Clear the flag in the same commit so a later normal visit doesn't re-arm selection.
  useEffect(() => {
    if (!pendingUncategorizedSelect) return;
    setTab('uncategorized');
    setSelectionMode(true);
    setSearch('');
    clearUncategorizedSelect();
  }, [pendingUncategorizedSelect, clearUncategorizedSelect]);
  // Only carry ids still in the live list — a background refetch (pull-to-refresh) can evict a
  // selected charge mid-selection, and this keeps the picker's "File N" count honest.
  const onRecategorize = () => {
    const live = new Set(transactions.map((t) => t.transaction_id));
    openMultiPicker([...selected].filter((id) => live.has(id)));
    exitSelection();
  };

  const view = { transactions, category };
  // WHIT-501: the badge / dot / "All caught up" now reflect the WHOLE history via the server tally,
  // not just the loaded pages. `serverCount` is undefined while loading/errored, so we fall back to
  // the loaded-page count — never to 0, which would flash a false "All caught up".
  const serverCount = useUncategorizedCount();
  const localUncategorized = countUncategorized(view);
  // Badge headline: the server's whole-history number once resolved, else the loaded-page count.
  // `??` uses a resolved 0 (0 isn't nullish); it only falls through to local while serverCount is undefined.
  const uncategorizedCount = serverCount ?? localUncategorized;
  // WHIT-517: the shops (merchant groups) behind unfiled charges, for the "File by shop" button.
  // `groups` is undefined while loading/errored, so the button only shows once we KNOW there is at
  // least one rule-able shop — a filing session that has cleared them all hides it, like the count.
  // WHIT-552: only run the heavy whole-history walk when the count says there's a backlog — a
  // caught-up user skips it. Same `uncategorizedCount > 0` the button gate below reads, so the
  // fetch and the button can't disagree.
  const { merchants } = useUncategorizedMerchants(uncategorizedCount > 0);
  // "All caught up" is the strong "every transaction is filed" claim — true ONLY on a RESOLVED server
  // 0, never during loading/error (undefined). Named once so the empty state and the two controls it
  // must exclude (search-no-results, Load More) can't drift.
  const allCaughtUp = tab === 'uncategorized' && serverCount === 0;
  // WHIT-576: once the server has answered THIS query, its full-history matches are the list.
  // Before that, show the loaded rows plus the previous answer. Either way the live text filters
  // them (before grouping), so typing narrows instantly and a just-re-filed row drops out.
  const searchingServer = needsServerSearch(query);
  const searchAnswered = searchingServer && debouncedQuery === query && serverSearch.answered;
  const searchFailed = searchingServer && serverSearch.isError;
  const searchPending = searchingServer && !searchAnswered && !searchFailed;
  let listSource = transactions;
  if (searchAnswered) listSource = serverSearch.results;
  else if (searchingServer) listSource = unionById([transactions, serverSearch.results]);
  const searched = query ? listSource.filter((t) => transactionMatchesSearch({ category }, t, query)) : listSource;
  const groups = transactionGroups({ transactions: searched, category }, tab === 'uncategorized' ? 'uncategorized' : 'all');

  const showError = isError && transactions.length === 0;
  const showSpinner = !showError && isLoading && transactions.length === 0;
  // The uncategorized feed is paged: when the badge says there ARE unfiled charges but none are
  // in the loaded pages yet, they sit deeper in history (a "Load More" away) — or a cross-device
  // re-tag left the badge briefly ahead of the list. Either way, show an explanatory state instead
  // of a bare, unexplained blank tab. Gated so it never competes with the search-no-results,
  // "All caught up", or cold-load states. `hasMore` distinguishes "keep loading" from "pull to
  // refresh"; the `serverCount > 0` arm covers the stale-badge skew when there are no more pages.
  const showUncategorizedMore = tab === 'uncategorized' && !allCaughtUp && groups.length === 0
    && query.length === 0 && !showSpinner && !showError && (hasMore || (serverCount ?? 0) > 0);
  // Pull-to-refresh (WHIT-489: shared hook): refresh the visible list AND fetch fresh account
  // balances live from the bank, with the WHIT-363 stuck-spinner invariant owned in one place.
  // The other screens (budgets, loan, rules, pay-cycle) refresh themselves on focus via their
  // own queries — pull doesn't reload the whole app.
  const { pulling, onRefresh } = usePullToRefresh(refetchList, refreshLiveBalances, showToast);

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
          // `showUncategorizedMore` is the ONE empty-list state that invites a pull ("pull down to
          // refresh"), so let the spinner show there too — otherwise the instruction gives no feedback.
          // (It requires !showSpinner, so it can never re-introduce the cold-load double-spin.)
          refreshing={pulling && (listSource.length > 0 || showUncategorizedMore)}
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
              maxLength={SEARCH_QUERY_MAX_LEN}
              accessibilityLabel="Search transactions"
            />
            {search.length > 0 && (
              <Pressable onPress={() => setSearch('')} hitSlop={10} accessibilityRole="button" accessibilityLabel="Clear search">
                <Text style={styles.searchClear}>✕</Text>
              </Pressable>
            )}
          </View>
        )}

        {tab === 'uncategorized' && localUncategorized > 0 && !selectionMode && (
          <View style={styles.hint}>
            <Glyph name="star" size={18} color={C.accentSoft} />
            <Text style={styles.hintText}>
              Tap a transaction to categorize it — and choose whether the call applies to{' '}
              <Text style={styles.hintBold}>just that one</Text> or <Text style={styles.hintBold}>every charge</Text> from that merchant.
            </Text>
          </View>
        )}

        {/* WHIT-508: rules only run as a charge ARRIVES, so history never gets re-labelled. This
            sweeps it. Gated on the WHOLE-history count (the badge's number), not the loaded-page
            count: after a capped run the loaded page can be empty while hundreds remain deeper in
            history, and that is exactly when the button is still needed. Hidden behind the cold
            spinner and the load error like every other control on this screen. */}
        {tab === 'uncategorized' && !selectionMode && !showSpinner && !showError && uncategorizedCount > 0 && (
          <Pressable
            testID="transactions-apply-rules"
            onPress={() => setSheet({ mode: 'applyRules' })}
            accessibilityRole="button"
            accessibilityLabel="Apply my rules to your unfiled charges"
            style={styles.applyRules}
          >
            <Text style={styles.applyRulesText}>Apply my rules</Text>
          </Pressable>
        )}

        {/* WHIT-517: the rest of the backlog — shops with NO rule yet. "Apply my rules" can't touch
            them (nothing covers them); this opens the shop list to file them a shop at a time,
            minting a rule as it goes. Same visibility gate as "Apply my rules", plus it needs at
            least one rule-able shop (merchants.groups), so it hides once every shop is filed even
            while stray one-offs keep the count above zero. */}
        {tab === 'uncategorized' && !selectionMode && !showSpinner && !showError && uncategorizedCount > 0 && (merchants?.groups.length ?? 0) > 0 && (
          <Pressable
            testID="transactions-file-by-shop"
            onPress={() => setSheet({ mode: 'fileByShopList' })}
            accessibilityRole="button"
            accessibilityLabel="File your unfiled charges by shop"
            style={styles.fileByShop}
          >
            <Text style={styles.fileByShopText}>File by shop</Text>
          </Pressable>
        )}

        <ListStates
          showSpinner={showSpinner}
          showError={showError}
          idPrefix="transactions"
          errorText="Couldn't load your transactions."
          retryLabel="Retry loading your transactions"
          onRetry={refetch}
        />

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

        {!showSpinner && !showError && searchPending && (
          <View testID="transactions-searching" style={styles.searchStatus}>
            <ActivityIndicator color={C.accent} />
            <Text style={styles.searchStatusText}>Searching your full history…</Text>
          </View>
        )}

        {!showSpinner && !showError && searchFailed && (
          <View testID="transactions-search-error" style={styles.searchStatus}>
            <Text style={styles.searchStatusText}>Couldn't search your full history.</Text>
            <Pressable onPress={serverSearch.retry} hitSlop={8} accessibilityRole="button" accessibilityLabel="Retry searching your full history">
              <Text style={styles.searchRetry}>Retry</Text>
            </Pressable>
          </View>
        )}

        {!showSpinner && !showError && searchAnswered && serverSearch.truncated && (
          <Text testID="transactions-search-truncated" style={styles.searchStatusText}>
            Showing the newest {serverSearch.results.length} matches — refine your search to see older ones.
          </Text>
        )}

        {/* Search returned nothing on this tab (the "all caught up" state below still owns the
            genuinely-empty uncategorized case, so don't double up on it). WHIT-576: only once the
            server has searched ALL history — never while it's still looking or after it failed. */}
        {!showSpinner && !showError && query.length > 0 && groups.length === 0 && !allCaughtUp && !searchPending && !searchFailed && (
          <View testID="transactions-no-results" style={styles.empty}>
            <View style={[styles.emptyIcon, { backgroundColor: 'rgba(255,255,255,.06)' }]}><Glyph name="search" size={30} color={C.textDim} /></View>
            <Text style={styles.emptyTitle}>No matches</Text>
            <Text style={styles.emptySub}>No transactions match “{query}”.</Text>
          </View>
        )}

        {/* WHIT-501: also require the tab to be genuinely empty (`groups.length === 0`). `allCaughtUp`
            is the WHOLE-history "server says 0" signal, which can briefly disagree with the loaded
            rows — a cross-device or server-side re-tag drops the server count to 0 while the feed
            cache (never invalidated on that path) still holds those rows. Without this gate the screen
            would show "Every transaction is categorized" ABOVE a visible list of uncategorized rows. */}
        {allCaughtUp && groups.length === 0 && !showSpinner && !showError && (
          <View style={styles.empty}>
            <View style={styles.emptyIcon}><Glyph name="check" size={32} color={C.good} /></View>
            <Text style={styles.emptyTitle}>All caught up</Text>
            <Text style={styles.emptySub}>Every transaction is categorized. New ones matching your rules file themselves automatically.</Text>
          </View>
        )}

        {/* Paged uncategorized feed: the badge says there are unfiled charges but none are in the
            loaded pages — they're deeper in history (Load More below), or a cross-device re-tag
            left the badge briefly ahead. Explain it rather than showing a blank tab. */}
        {showUncategorizedMore && (
          <View testID="transactions-uncategorized-more" style={styles.empty}>
            <View style={styles.emptyIcon}><Glyph name="search" size={30} color={C.accentSoft} /></View>
            <Text style={styles.emptyTitle}>{hasMore ? 'More to load' : 'Nothing to show yet'}</Text>
            <Text style={styles.emptySub}>
              {hasMore
                ? 'Your unfiled charges are further back in history. Keep loading to see them.'
                : 'Pull down to refresh this list.'}
            </Text>
          </View>
        )}

        {/* Load More: page older history in via the feed cursor. Hidden at end-of-history
            (hasMore false), while the cold-load spinner / error own the empty state, and on the
            uncategorized "all caught up" empty state (nothing to page toward there). The newest
            batch shows first; each tap appends the next, older batch. Hidden during a search
            (WHIT-576): the server already searched all history. */}
        {!showSpinner && !showError && hasMore && !allCaughtUp && !searchingServer && (
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
    <Pressable testID={`tab-${label.toLowerCase()}`} onPress={onPress} style={({ pressed }) => [styles.segBtn, { flex, backgroundColor: active ? '#fff' : 'transparent' }, pressed && styles.segPressed]}>
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

  // WHIT-576: the full-history search's status line (searching / failed / cut off).
  searchStatus: { flexDirection: 'row', gap: 10, alignItems: 'center', justifyContent: 'center', marginTop: 18, paddingVertical: 8 },
  searchStatusText: { fontFamily: FONT.body, fontSize: 13, color: C.textDim, textAlign: 'center', marginTop: 12 },
  searchRetry: { fontFamily: FONT.body, fontSize: 13, fontWeight: '600', color: C.accentSoft, marginTop: 12 },

  // "Apply my rules" (WHIT-508): the Load More treatment, sitting under the hint.
  applyRules: { marginTop: 10, paddingVertical: 12, borderRadius: 13, borderWidth: 1, borderColor: C.hairline, alignItems: 'center' },
  applyRulesText: { fontFamily: FONT.body, fontSize: 14, fontWeight: '600', color: C.accentSoft },
  // WHIT-517: filled accent (primary) — this clears the bulk of the backlog, so it reads louder
  // than the outlined "Apply my rules" above it.
  fileByShop: { marginTop: 10, paddingVertical: 12, borderRadius: 13, backgroundColor: C.accent, alignItems: 'center' },
  fileByShopText: { fontFamily: FONT.body, fontSize: 14, fontWeight: '700', color: C.accentInk },
});
