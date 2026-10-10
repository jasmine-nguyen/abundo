import { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';
import { C, FONT, tint, PRESSED, fmtExact, fmtSignedExact } from '../../src/theme';
import { Glyph } from '../../src/icons';
import { transactionGroups, transactionMatchesSearch, countUncategorized, unionById, useAppContext, SEARCH_QUERY_MAX_LEN } from '../../src/context';
import { useTransactionsScreenData, useUncategorizedCount, useUncategorizedMerchants } from '../../src/queries';
import { usePullToRefresh } from '../../src/hooks/usePullToRefresh';
import { useDebouncedValue } from '../../src/hooks/useDebouncedValue';
import { ScrollChromeHeader, ASK_BUTTON_BOTTOM_CLEARANCE } from '../../src/motion/ScrollChromeHeader';
import { TransactionRow } from '../../src/components/TransactionRow';
import { ListStates, StaleDataLine } from '../../src/components/ListStates';
import { EmptyState } from '../../src/components/EmptyState';
import { SegmentedControl } from '../../src/components/SegmentedControl';
import { SearchField } from '../../src/components/SearchField';
import { useFirstFilingSeen } from '../../src/hooks/useFirstFilingSeen';
import { HeaderTextButton } from '../../src/components/ui';
import { toggleIn } from '../../src/setutil';

type Tab = 'all' | 'uncategorized';

// WHIT-576: how long typing must pause before the full-history search asks the server.
const SEARCH_DEBOUNCE_MS = 300;

// The selected tab's soft tint — the Insights cycle toggle's recipe (DESIGN.md › Segmented control).
const TAB_TINT = tint(C.accentAlt, 0.16);

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
  const { openMultiPicker, showToast, sheet, setSheet, pendingUncategorizedSelect, clearUncategorizedSelect } = useAppContext();
  // WHIT-846: the Uncategorised hint hides for good once the user reaches a category pick's
  // confirm step (one charge, a selection, or File by shop).
  const { seen: firstFilingSeen, markSeen: markFirstFilingSeen } = useFirstFilingSeen();
  const sheetMode = sheet?.mode;
  useEffect(() => {
    if (firstFilingSeen !== false) return;
    if (sheetMode === 'confirm' || sheetMode === 'confirmMany' || sheetMode === 'fileByShopConfirm') markFirstFilingSeen();
  }, [sheetMode, firstFilingSeen, markFirstFilingSeen]);
  // WHIT-190a: transactions now come from the cached, auth-gated query layer — an all-accounts
  // cursor feed, so `loadMore` pages older history in and `hasMore` is false at end-of-history.
  const { transactions, category, isLoading, isError, error, refreshError, updatedAt, refetch, refetchStale, refetchList, refreshLiveBalances, hasMore, loadMore, isLoadingMore, search: serverSearch } = useTransactionsScreenData(tab, serverQuery);
  useFocusEffect(useCallback(() => { refetchStale(); }, [refetchStale]));

  // WHIT-291: multi-select re-categorise. `selectionMode` swaps the rows for checkboxes; `selected`
  // holds the chosen ids. Exiting (Cancel, tab switch) clears the set. Tapping "Re-categorise"
  // captures the ids into the picker sheet (openMultiPicker) and leaves selection mode — cancelling
  // the picker returns to the normal list.
  const [selectionMode, setSelectionMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const exitSelection = useCallback(() => { setSelectionMode(false); setSelected(new Set()); }, []);
  const toggleSelect = useCallback((id: string) => setSelected((prev) => toggleIn(prev, id)), []);
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
  const searchFailed = searchingServer && debouncedQuery === query && serverSearch.isError;
  const searchPending = searchingServer && !searchAnswered && !searchFailed;
  let listSource = transactions;
  if (searchAnswered) listSource = serverSearch.results;
  else if (searchingServer) listSource = unionById([transactions, serverSearch.results]);
  const searched = query ? listSource.filter((t) => transactionMatchesSearch({ category }, t, query)) : listSource;
  const groups = transactionGroups({ transactions: searched, category }, tab === 'uncategorized' ? 'uncategorized' : 'all');

  const showError = isError && transactions.length === 0;
  const showSpinner = !showError && isLoading && transactions.length === 0;
  // WHIT-848: "N matches · ±$X" for an answered search. A complete answer sums the rows shown, so
  // it always agrees with the list; a cut-off one uses the server's figures over every match.
  const shownMatches = groups.flatMap((g) => g.items);
  let matchCount = shownMatches.length;
  let matchTotal = shownMatches.reduce((sum, t) => sum + Math.round((t.amount || 0) * 100), 0) / 100;
  if (serverSearch.truncated) {
    matchCount = serverSearch.matchCount;
    matchTotal = serverSearch.matchTotal;
  }
  const showMatchSummary = !showSpinner && !showError && searchAnswered && matchCount > 0;
  const matchSummary = `${matchCount} ${matchCount === 1 ? 'match' : 'matches'} · ${matchTotal > 0 ? '+' + fmtExact(matchTotal) : fmtSignedExact(matchTotal)}`;
  // The uncategorized feed is paged: when the badge says there ARE unfiled charges but none are
  // in the loaded pages yet, they sit deeper in history (a "Load More" away) — or a cross-device
  // re-tag left the badge briefly ahead of the list. Either way, show an explanatory state instead
  // of a bare, unexplained blank tab. Gated so it never competes with the search-no-results,
  // "All caught up", or cold-load states. `hasMore` distinguishes "keep loading" from "pull to
  // refresh"; the `serverCount > 0` arm covers the stale-badge skew when there are no more pages.
  const showUncategorizedMore = tab === 'uncategorized' && !allCaughtUp && groups.length === 0
    && !searchingServer && !showSpinner && !showError && (hasMore || (serverCount ?? 0) > 0);
  // Pull-to-refresh (WHIT-489: shared hook): refresh the visible list AND fetch fresh account
  // balances live from the bank, with the WHIT-363 stuck-spinner invariant owned in one place.
  // The other screens (budgets, loan, rules, pay-cycle) refresh themselves on focus via their
  // own queries — pull doesn't reload the whole app.
  const { pulling, onRefresh } = usePullToRefresh(refetchList, refreshLiveBalances, showToast);

  // Scroll-to-hide chrome + the floating header now live in the shared ScrollChromeHeader
  // wrapper (WHIT-199). This screen passes its own refreshing/onRefresh; the wrapper builds the
  // spinner and offsets it below the header (WHIT-211 — otherwise it draws behind the header).
  // WHIT-291: a "Select" button enters selection mode; it becomes "Cancel" while selecting.
  const headerRight = selectionMode ? (
    <HeaderTextButton label="Cancel" onPress={exitSelection} />
  ) : (
    <HeaderTextButton label="Select" onPress={() => { setSelectionMode(true); setSearch(''); }} />
  );

  return (
    <View style={{ flex: 1 }}>
    <ScrollChromeHeader
      title="Transactions"
      right={headerRight}
      contentContainerStyle={selectionMode ? styles.contentWithBar : undefined}
      keyboardShouldPersistTaps="handled"
      // WHIT-363: the pull spinner shows only for a user pull (`pulling`), cleared when that
      // pull's fetch ends — so the silent on-focus/background refetch never raises it. The
      // `length > 0` guard stops a pull during the cold-load window from double-spinning with
      // the inline loading spinner (showSpinner), which owns the empty first-load state.
      // `showUncategorizedMore` is the ONE empty-list state that invites a pull ("pull down to
      // refresh"), so let the spinner show there too — otherwise the instruction gives no feedback.
      // (It requires !showSpinner, so it can never re-introduce the cold-load double-spin.)
      refreshing={pulling && (listSource.length > 0 || showUncategorizedMore)}
      onRefresh={onRefresh}
    >
        <SegmentedControl
          value={tab}
          onChange={changeTab}
          options={[
            { value: 'all', label: 'All', testID: 'tab-all', activeTint: TAB_TINT, activeTextColor: C.accentSoft },
            { value: 'uncategorized', label: 'Uncategorised', testID: 'tab-uncategorized', activeTint: TAB_TINT, activeTextColor: C.accentSoft, flex: 1.45, badge: uncategorizedCount },
          ]}
        />

        {!selectionMode && (
          <SearchField
            value={search}
            onChangeText={setSearch}
            placeholder="Search transactions"
            accessibilityLabel="Search transactions"
            maxLength={SEARCH_QUERY_MAX_LEN}
          />
        )}

        {!searchingServer && !showSpinner && !showError && (
          <StaleDataLine idPrefix="transactions" error={refreshError} updatedAt={updatedAt} showUpdated />
        )}

        {showMatchSummary && (
          <Text testID="transactions-search-summary" style={[styles.searchStatusText, styles.searchSummary]}>{matchSummary}</Text>
        )}

        {tab === 'uncategorized' && localUncategorized > 0 && !selectionMode && firstFilingSeen === false && (
          <View style={styles.hint}>
            <Glyph name="star" size={18} color={C.accentSoft} />
            <Text style={styles.hintText}>
              Tap a transaction to categorise it — and choose whether the call applies to{' '}
              <Text style={styles.hintBold}>just that one</Text> or <Text style={styles.hintBold}>every charge</Text> from that merchant.
            </Text>
          </View>
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

        {/* WHIT-508: rules only run as a charge ARRIVES, so history never gets re-labelled. This
            sweeps it. Gated on the WHOLE-history count (the badge's number), not the loaded-page
            count: after a capped run the loaded page can be empty while hundreds remain deeper in
            history, and that is exactly when the link is still needed. Hidden behind the cold
            spinner and the load error like every other control on this screen. */}
        {tab === 'uncategorized' && !selectionMode && !showSpinner && !showError && uncategorizedCount > 0 && (
          <Pressable
            testID="transactions-apply-rules"
            onPress={() => setSheet({ mode: 'applyRules' })}
            accessibilityRole="button"
            accessibilityLabel="Apply my rules to your unfiled charges"
            style={({ pressed }) => [styles.applyRulesLink, pressed && PRESSED]}
          >
            <Text style={styles.applyRulesLinkText}>Apply my rules</Text>
          </Pressable>
        )}

        <ListStates
          showSpinner={showSpinner}
          showError={showError}
          idPrefix="transactions"
          errorText="Couldn't load your transactions."
          retryLabel="Retry loading your transactions"
          onRetry={refetch}
          error={error}
        />

        {!showSpinner && !showError && groups.map((g) => {
          const heading = g.dayTotal ? `${g.label} · ${g.dayTotal}` : g.label;
          return (
            <View key={g.label} style={{ marginTop: 18 }}>
              <Text style={styles.groupLabel}>{heading}</Text>
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
          );
        })}

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
        {!showSpinner && !showError && searchAnswered && groups.length === 0 && !allCaughtUp && (
          <EmptyState
            testID="transactions-no-results"
            icon={<Glyph name="search" size={30} color={C.textDim} />}
            iconBackground={C.neutralWash}
            title="No matches"
            sub={<>No transactions match “{query}”.</>}
          />
        )}

        {/* WHIT-501: also require the tab to be genuinely empty (`groups.length === 0`). `allCaughtUp`
            is the WHOLE-history "server says 0" signal, which can briefly disagree with the loaded
            rows — a cross-device or server-side re-tag drops the server count to 0 while the feed
            cache (never invalidated on that path) still holds those rows. Without this gate the screen
            would show "Every transaction is categorised" ABOVE a visible list of uncategorized rows. */}
        {allCaughtUp && groups.length === 0 && !showSpinner && !showError && (
          <EmptyState
            icon={<Glyph name="check" size={32} color={C.good} />}
            title="All caught up"
            sub="Every transaction is categorised. New ones matching your rules file themselves automatically."
          />
        )}

        {/* Paged uncategorized feed: the badge says there are unfiled charges but none are in the
            loaded pages — they're deeper in history (Load More below), or a cross-device re-tag
            left the badge briefly ahead. Explain it rather than showing a blank tab. */}
        {showUncategorizedMore && (
          <EmptyState
            testID="transactions-uncategorized-more"
            icon={<Glyph name="search" size={30} color={C.accentSoft} />}
            title={hasMore ? 'More to load' : 'Nothing to show yet'}
            sub={hasMore
              ? 'Your unfiled charges are further back in history. Keep loading to see them.'
              : 'Pull down to refresh this list.'}
          />
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
              style={({ pressed }) => [styles.loadMore, pressed && PRESSED]}
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
          accessibilityLabel="Re-categorise selected transactions"
          style={[styles.actionBtn, selected.size === 0 && styles.actionBtnDisabled]}
        >
          <Text style={[styles.actionBtnText, selected.size === 0 && styles.actionBtnTextDisabled]}>Re-categorise</Text>
        </Pressable>
      </View>
    )}
    </View>
  );
}

const styles = StyleSheet.create({
  // WHIT-291: header Select/Cancel button.
  // Extra bottom padding so the last rows can scroll clear of the floating action bar and the
  // Ask pill (card 609).
  contentWithBar: { paddingBottom: 108 + ASK_BUTTON_BOTTOM_CLEARANCE },
  actionBar: { position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingTop: 12, paddingHorizontal: 18, backgroundColor: C.sheet, borderTopWidth: 1, borderTopColor: C.hairline },
  actionCount: { fontFamily: FONT.body, fontSize: 14.5, fontWeight: '600', color: C.textMid },
  actionBtn: { paddingVertical: 12, paddingHorizontal: 20, borderRadius: 13, backgroundColor: C.accent },
  actionBtnDisabled: { backgroundColor: tint(C.accentAlt, 0.22) },
  actionBtnText: { fontFamily: FONT.body, fontSize: 14.5, fontWeight: '700', color: C.accentInk },
  actionBtnTextDisabled: { color: C.textDisabled },

  hint: { flexDirection: 'row', gap: 11, alignItems: 'flex-start', backgroundColor: tint(C.accentAlt, 0.1), borderWidth: 1, borderColor: tint(C.accentAlt, 0.22), borderRadius: 16, padding: 13, paddingHorizontal: 14, marginTop: 10 },
  hintText: { flex: 1, fontFamily: FONT.body, fontSize: 12.5, color: C.accentSofter, lineHeight: 18 },
  hintBold: { color: C.textBright, fontWeight: '700' },

  groupLabel: { fontFamily: FONT.body, fontSize: 13, fontWeight: '700', color: C.textMid, letterSpacing: 0.2, marginHorizontal: 4, marginBottom: 4 },

  // Load More: same treatment as the budget-detail reveal button (app/budget/[id]), plus a
  // matched-height spinner slot so the list doesn't jump when it swaps in while a page loads.
  loadMore: { marginTop: 18, paddingVertical: 12, borderRadius: 13, borderWidth: 1, borderColor: C.hairline, alignItems: 'center' },
  loadMoreText: { fontFamily: FONT.body, fontSize: 14, fontWeight: '600', color: C.accentSoft },
  loadMoreState: { marginTop: 18, paddingVertical: 12, alignItems: 'center', justifyContent: 'center' },

  // WHIT-576: the full-history search's status line (searching / failed / cut off).
  searchStatus: { flexDirection: 'row', gap: 10, alignItems: 'center', justifyContent: 'center', marginTop: 18, paddingVertical: 8 },
  searchStatusText: { fontFamily: FONT.body, fontSize: 13, color: C.textDim, textAlign: 'center', marginTop: 12 },
  searchSummary: { color: C.textMid, fontWeight: '600' },
  searchRetry: { fontFamily: FONT.body, fontSize: 13, fontWeight: '600', color: C.accentSoft, marginTop: 12 },

  // WHIT-517 / WHIT-846: filled accent — the tab's one main button.
  fileByShop: { marginTop: 10, paddingVertical: 12, borderRadius: 13, backgroundColor: C.accent, alignItems: 'center' },
  fileByShopText: { fontFamily: FONT.body, fontSize: 14, fontWeight: '700', color: C.accentInk },
  // "Apply my rules" (WHIT-508): a quiet text link under File by shop.
  applyRulesLink: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  applyRulesLinkText: { fontFamily: FONT.body, fontSize: 14, fontWeight: '600', color: C.accentSoft },
});
