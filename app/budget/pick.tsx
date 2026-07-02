import React from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, FONT, tint, fmt } from '../../src/theme';
import { Icon, Glyph } from '../../src/icons';
import { useAppContext } from '../../src/context';
import { Header } from '../../src/components/Header';

export default function BudgetPick() {
  const s = useAppContext();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const budgeted = s.budgets.map((b) => b.id);
  const list = s.categories.filter((c) => !budgeted.includes(c.id) && c.bucket !== 'Income');

  return (
    <View style={{ flex: 1, paddingTop: insets.top + 6 }}>
      <Header title="Add a budget" />
      <ScrollView contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: insets.bottom + 30 }} showsVerticalScrollIndicator={false}>
        <Text style={styles.title}>Kick things off by <Text style={{ color: C.accentSoft }}>picking a category to budget</Text></Text>
        <Text style={styles.sub}>Here are your typical spends per fortnight, so far without a budget.</Text>

        <View style={styles.search}>
          <Glyph name="search" size={18} color="#6e6e78" />
          <Text style={styles.searchText}>Search categories</Text>
        </View>

        {list.length === 0 && (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>Every category already has a budget. Nice.</Text>
          </View>
        )}

        {list.map((c) => (
          <Pressable key={c.id} onPress={() => router.push(`/budget/edit?categoryId=${c.id}&from=pick`)} style={styles.row}>
            <View style={[styles.chip, { backgroundColor: tint(c.color, 0.15) }]}><Icon name={c.icon} size={22} color={c.color} /></View>
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>{c.name}</Text>
              <Text style={styles.bucket}>{c.bucket}</Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={styles.recent}>{fmt(c.recent)}</Text>
              <Text style={styles.recentSub}>avg / fortnight</Text>
            </View>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  title: { fontFamily: FONT.display, fontSize: 24, fontWeight: '700', color: C.text, lineHeight: 30, letterSpacing: -0.4, paddingHorizontal: 2, paddingTop: 4 },
  sub: { fontFamily: FONT.body, fontSize: 13.5, color: C.textDim, marginHorizontal: 2, marginTop: 10, marginBottom: 16 },
  search: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 13, paddingVertical: 11, paddingHorizontal: 14, marginBottom: 8 },
  searchText: { fontFamily: FONT.body, fontSize: 14, color: '#6e6e78' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 13, paddingVertical: 14, paddingHorizontal: 14, backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 16, marginBottom: 10 },
  chip: { width: 42, height: 42, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  name: { fontFamily: FONT.body, fontSize: 15, fontWeight: '600', color: C.textBright },
  bucket: { fontFamily: FONT.body, fontSize: 12.5, color: C.textDim, marginTop: 2 },
  recent: { fontFamily: FONT.display, fontSize: 14.5, fontWeight: '700', color: '#cfd2ff' },
  recentSub: { fontFamily: FONT.body, fontSize: 11, color: C.textDim },
  empty: { alignItems: 'center', paddingVertical: 50, paddingHorizontal: 24 },
  emptyText: { fontFamily: FONT.body, fontSize: 14, color: C.textDim, textAlign: 'center' },
});
