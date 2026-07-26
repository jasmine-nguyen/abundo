import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, Pressable, StyleSheet, SectionList, ActivityIndicator, TextInput } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';
import { C, FONT, tint } from '../src/theme';
import { Icon, Glyph } from '../src/icons';
import { useAppContext, groupRulesByCategory, UNCATEGORIZED_RULE_GROUP } from '../src/context';
import type { Category, Rule } from '../src/context';
import { useRulesScreenData, useCategories } from '../src/queries';
import { useDebouncedValue } from '../src/hooks/useDebouncedValue';
import { Header } from '../src/components/Header';
import { RetryButton } from '../src/components/ui';

// How long typing must settle before the filter recomputes. The text box stays instant;
// only the (potentially large) grouping recompute waits, so fast typing never stutters.
const SEARCH_DEBOUNCE_MS = 250;

export default function Rules() {
  const s = useAppContext(); // setSheet + deleteRule (writers)
  const insets = useSafeAreaInsets();

  // WHIT-195: the rule list comes from the cached ['rules'] query; WHIT-203: the category
  // label per rule now comes from the shared taxonomy hook (not the old store).
  const { rules, isLoading, isError, refetch, refetchStale } = useRulesScreenData();
  const { categories } = useCategories();
  useFocusEffect(useCallback(() => { refetchStale(); }, [refetchStale]));

  // `query` drives the text box live (instant keystrokes + clear button + the box's own
  // visibility); its debounced copy drives the filter so a burst of typing recomputes once.
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);

  // Group the flat list under one header per category, filtered by the (debounced) search. A
  // categories outage/cold-load leaves `categories` empty, so every rule resolves as an
  // orphan and lands under one "Uncategorized" header until the taxonomy loads — the rows
  // stay listed, editable, and deletable, so it degrades gracefully rather than erroring.
  const groups = useMemo(
    () => groupRulesByCategory(rules, categories, debouncedQuery),
    [rules, categories, debouncedQuery],
  );

  const showList = !isError && !(isLoading && rules.length === 0);
  const noMatches = showList && groups.length === 0 && debouncedQuery.trim().length > 0;

  // Map the groups to SectionList sections. Key namespaced (`cat:<slug>` vs `orphan`) so a
  // real category named "Uncategorized" can't collide with the orphan group's section key.
  const sections = useMemo(
    () =>
      showList
        ? groups.map((group) => ({
            key: group.category ? `cat:${group.category.id}` : 'orphan',
            category: group.category,
            data: group.rules,
          }))
        : [],
    [groups, showList],
  );

  const intro = (
    <View style={styles.intro}>
      <View style={styles.introIcon}><Glyph name="sliders" size={22} color={C.accentSoft} /></View>
      <Text style={styles.introText}>
        Rules categorize matching merchants the moment a transaction lands — <Text style={styles.introBold}>posted or pending</Text>. You have {rules.length} active {rules.length === 1 ? 'rule' : 'rules'}.
      </Text>
    </View>
  );

  const footer = (
    <Pressable onPress={() => s.setSheet({ mode: 'addrule' })} style={styles.newRuleBtn}>
      <Glyph name="plus" size={18} color={C.accentSoft} />
      <Text style={styles.newRuleText}>Add a rule</Text>
    </Pressable>
  );

  // Renders in place of the rows when there are none: the load/error/no-match cards. Returns
  // null for the genuinely-empty idle case (no rules, no query), so only intro + footer show.
  const renderEmpty = () => {
    if (isError) {
      return (
        <View style={styles.stateCard}>
          <Text style={styles.stateText}>Could not load your rules.</Text>
          <RetryButton onPress={() => refetch()} label="Retry loading your rules" testID="rules-retry" style={styles.retryBtn} textStyle={styles.retryText} />
        </View>
      );
    }
    if (isLoading && rules.length === 0) {
      return (
        <View style={styles.stateCard}>
          <ActivityIndicator color={C.accentSoft} />
          <Text style={styles.stateText}>Loading rules…</Text>
        </View>
      );
    }
    if (noMatches) {
      return (
        <View style={styles.stateCard}>
          <Text style={styles.stateText}>No rules match “{debouncedQuery.trim()}”.</Text>
        </View>
      );
    }
    return null;
  };

  // Stable renderer identities so SectionList can skip re-rendering unchanged cells while
  // typing (a keystroke re-renders this screen, but the cell renderers don't change).
  const renderSectionHeader = useCallback(({ section }: { section: { category: Category | null; data: readonly Rule[] } }) => {
    const color = section.category?.color ?? '#888';
    const name = section.category?.name ?? UNCATEGORIZED_RULE_GROUP;
    return (
      <View style={styles.sectionHeader}>
        <View style={[styles.sectionChip, { backgroundColor: tint(color, 0.15) }]}>
          <Icon name={section.category?.icon ?? 'q'} size={17} color={color} />
        </View>
        <Text style={[styles.sectionHeaderText, { color }]}>{name}</Text>
        <Text style={styles.sectionCount}>{section.data.length}</Text>
      </View>
    );
  }, []);

  const renderItem = useCallback(({ item }: { item: Rule }) => (
    <View style={styles.row}>
      <Pressable testID={`edit-rule-${item.id}`} onPress={() => s.setSheet({ mode: 'addrule', ruleId: item.id })} style={styles.ruleBody}>
        <Text style={styles.pattern} numberOfLines={1}>{item.pattern}</Text>
        <Glyph name="chevron" size={15} color={C.textFaint} />
      </Pressable>
      {item.isNew && <Text style={styles.newBadge}>NEW</Text>}
      <Pressable testID={`delete-rule-${item.id}`} onPress={() => s.deleteRule(item.id)} style={styles.trash}>
        <Glyph name="trash" size={18} color={C.textFaint} />
      </Pressable>
    </View>
  ), [s]);

  return (
    <View style={{ flex: 1, paddingTop: insets.top + 6 }}>
      <Header
        title="Automation rules"
        right={
          <Pressable onPress={() => s.setSheet({ mode: 'addrule' })} style={styles.addBtn}>
            <Glyph name="plus" size={22} color={C.accentSoft} />
          </Pressable>
        }
      />

      {/* Pinned search — stays in reach above the scrolling list. Reads live `query`, so the
          box never flickers away mid-clear while the filtered list catches up. */}
      {(rules.length > 0 || query.length > 0) && (
        <View style={styles.searchWrap}>
          <View style={styles.search}>
            <Glyph name="search" size={18} color="#6e6e78" />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search rules"
              placeholderTextColor="#6e6e78"
              style={styles.searchInput}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              accessibilityLabel="Search rules"
            />
            {query.length > 0 && (
              <Pressable onPress={() => setQuery('')} hitSlop={10} accessibilityRole="button" accessibilityLabel="Clear search">
                <Text style={styles.searchClear}>✕</Text>
              </Pressable>
            )}
          </View>
        </View>
      )}

      <SectionList
        style={{ flex: 1 }}
        sections={sections}
        keyExtractor={(item) => item.id}
        renderSectionHeader={renderSectionHeader}
        renderItem={renderItem}
        ListHeaderComponent={intro}
        ListFooterComponent={footer}
        ListEmptyComponent={renderEmpty}
        contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: insets.bottom + 30 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        stickySectionHeadersEnabled={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  addBtn: { width: 40, height: 40, backgroundColor: 'rgba(124,140,255,.16)', borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  searchWrap: { paddingHorizontal: 18, paddingTop: 6, paddingBottom: 4 },
  search: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 13, paddingVertical: 4, paddingHorizontal: 14 },
  searchInput: { flex: 1, fontFamily: FONT.body, fontSize: 14, color: C.textBright, paddingVertical: 8, padding: 0 },
  searchClear: { fontFamily: FONT.body, fontSize: 15, fontWeight: '600', color: '#6e6e78', paddingHorizontal: 2 },
  // marginBottom 4 (not 14): the section header's marginTop 16 supplies the gap below the
  // intro, so first-section spacing (4 + 16 = 20) matches the pre-SectionList layout.
  intro: { flexDirection: 'row', gap: 12, alignItems: 'flex-start', backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 16, padding: 14, marginTop: 6, marginBottom: 4 },
  introIcon: { width: 40, height: 40, borderRadius: 12, backgroundColor: 'rgba(124,140,255,.14)', alignItems: 'center', justifyContent: 'center' },
  introText: { flex: 1, fontFamily: FONT.body, fontSize: 13, color: '#b6b6c0', lineHeight: 19 },
  introBold: { color: '#fff', fontWeight: '700' },
  // marginTop absorbs the removed group-wrapper marginBottom so inter-section spacing (~24px:
  // prev row marginBottom 8 + this 16) matches the pre-SectionList ScrollView layout.
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 16, marginBottom: 8 },
  sectionChip: { width: 30, height: 30, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  sectionHeaderText: { flex: 1, fontFamily: FONT.body, fontSize: 13.5, fontWeight: '700', letterSpacing: 0.3 },
  sectionCount: { fontFamily: FONT.body, fontSize: 12.5, fontWeight: '600', color: C.textFaint },
  row: { flexDirection: 'row', alignItems: 'center', gap: 13, backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 14, paddingVertical: 13, paddingHorizontal: 14, marginBottom: 8 },
  ruleBody: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
  pattern: { flex: 1, fontFamily: FONT.body, fontSize: 14.5, fontWeight: '700', color: C.textBright, letterSpacing: 0.2 },
  newBadge: { fontFamily: FONT.body, fontSize: 10, fontWeight: '700', color: C.good, backgroundColor: tint(C.good, 0.14), paddingVertical: 3, paddingHorizontal: 7, borderRadius: 6, overflow: 'hidden' },
  trash: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  stateCard: { alignItems: 'center', justifyContent: 'center', gap: 12, backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 14, paddingVertical: 28, paddingHorizontal: 14, marginBottom: 8 },
  stateText: { fontFamily: FONT.body, fontSize: 13.5, color: C.textDim, textAlign: 'center' },
  retryBtn: { paddingVertical: 9, paddingHorizontal: 18, borderRadius: 10, backgroundColor: 'rgba(124,140,255,.16)' },
  retryText: { fontFamily: FONT.body, fontSize: 13.5, fontWeight: '600', color: C.accentSoft },
  newRuleBtn: { marginTop: 8, paddingVertical: 16, borderWidth: 1, borderStyle: 'dashed', borderColor: 'rgba(124,140,255,.4)', backgroundColor: 'rgba(124,140,255,.07)', borderRadius: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  newRuleText: { fontFamily: FONT.body, fontSize: 15, fontWeight: '600', color: C.accentSoft },
});
