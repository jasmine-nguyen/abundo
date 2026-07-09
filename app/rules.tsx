import React, { useCallback } from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';
import { C, FONT, tint } from '../src/theme';
import { Icon, Glyph } from '../src/icons';
import { useAppContext } from '../src/context';
import { useRulesScreenData, useCategories } from '../src/queries';
import { Header } from '../src/components/Header';
import { RetryButton } from '../src/components/ui';

export default function Rules() {
  const s = useAppContext(); // setSheet + deleteRule (writers)
  const insets = useSafeAreaInsets();

  // WHIT-195: the rule list comes from the cached ['rules'] query; WHIT-203: the category
  // label per rule now comes from the shared taxonomy hook (not the old store).
  const { rules, isLoading, isError, refetch, refetchStale } = useRulesScreenData();
  const { category } = useCategories();
  useFocusEffect(useCallback(() => { refetchStale(); }, [refetchStale]));

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
      <ScrollView contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: insets.bottom + 30 }} showsVerticalScrollIndicator={false}>
        <View style={styles.intro}>
          <View style={styles.introIcon}><Glyph name="sliders" size={22} color={C.accentSoft} /></View>
          <Text style={styles.introText}>
            Rules categorize matching merchants the moment a transaction lands — <Text style={styles.introBold}>posted or pending</Text>. You have {rules.length} active {rules.length === 1 ? 'rule' : 'rules'}.
          </Text>
        </View>

        {isError ? (
          <View style={styles.stateCard}>
            <Text style={styles.stateText}>Could not load your rules.</Text>
            <RetryButton onPress={() => refetch()} label="Retry loading your rules" testID="rules-retry" style={styles.retryBtn} textStyle={styles.retryText} />
          </View>
        ) : isLoading && rules.length === 0 ? (
          <View style={styles.stateCard}>
            <ActivityIndicator color={C.accentSoft} />
            <Text style={styles.stateText}>Loading rules…</Text>
          </View>
        ) : (
          rules.map((r) => {
            const c = category(r.categoryId);
            const color = c?.color ?? '#888';
            return (
              <View key={r.id} style={styles.row}>
                <View style={[styles.chip, { backgroundColor: tint(color, 0.15) }]}><Icon name={c?.icon ?? 'q'} size={20} color={color} /></View>
                <Pressable testID={`edit-rule-${r.id}`} onPress={() => s.setSheet({ mode: 'addrule', ruleId: r.id })} style={styles.ruleBody}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.pattern}>{r.pattern}</Text>
                    <Text style={styles.target}>→ <Text style={{ color, fontWeight: '600' }}>{c?.name ?? '—'}</Text></Text>
                  </View>
                  <Glyph name="chevron" size={15} color={C.textFaint} />
                </Pressable>
                {r.isNew && <Text style={styles.newBadge}>NEW</Text>}
                <Pressable testID={`delete-rule-${r.id}`} onPress={() => s.deleteRule(r.id)} style={styles.trash}>
                  <Glyph name="trash" size={18} color={C.textFaint} />
                </Pressable>
              </View>
            );
          })
        )}

        <Pressable onPress={() => s.setSheet({ mode: 'addrule' })} style={styles.newRuleBtn}>
          <Glyph name="plus" size={18} color={C.accentSoft} />
          <Text style={styles.newRuleText}>Add a rule</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  addBtn: { width: 40, height: 40, backgroundColor: 'rgba(124,140,255,.16)', borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  intro: { flexDirection: 'row', gap: 12, alignItems: 'flex-start', backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 16, padding: 14, marginBottom: 14 },
  introIcon: { width: 40, height: 40, borderRadius: 12, backgroundColor: 'rgba(124,140,255,.14)', alignItems: 'center', justifyContent: 'center' },
  introText: { flex: 1, fontFamily: FONT.body, fontSize: 13, color: '#b6b6c0', lineHeight: 19 },
  introBold: { color: '#fff', fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 13, backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 14, paddingVertical: 13, paddingHorizontal: 14, marginBottom: 8 },
  chip: { width: 38, height: 38, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  ruleBody: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
  pattern: { fontFamily: FONT.body, fontSize: 14.5, fontWeight: '700', color: C.textBright, letterSpacing: 0.2 },
  target: { fontFamily: FONT.body, fontSize: 12.5, color: C.textDim, marginTop: 2 },
  newBadge: { fontFamily: FONT.body, fontSize: 10, fontWeight: '700', color: C.good, backgroundColor: 'rgba(53,217,160,.14)', paddingVertical: 3, paddingHorizontal: 7, borderRadius: 6, overflow: 'hidden' },
  trash: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  stateCard: { alignItems: 'center', justifyContent: 'center', gap: 12, backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 14, paddingVertical: 28, paddingHorizontal: 14, marginBottom: 8 },
  stateText: { fontFamily: FONT.body, fontSize: 13.5, color: C.textDim, textAlign: 'center' },
  retryBtn: { paddingVertical: 9, paddingHorizontal: 18, borderRadius: 10, backgroundColor: 'rgba(124,140,255,.16)' },
  retryText: { fontFamily: FONT.body, fontSize: 13.5, fontWeight: '600', color: C.accentSoft },
  newRuleBtn: { marginTop: 8, paddingVertical: 16, borderWidth: 1, borderStyle: 'dashed', borderColor: 'rgba(124,140,255,.4)', backgroundColor: 'rgba(124,140,255,.07)', borderRadius: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  newRuleText: { fontFamily: FONT.body, fontSize: 15, fontWeight: '600', color: C.accentSoft },
});
