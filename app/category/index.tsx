import React from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, FONT, tint } from '../../src/theme';
import { Icon, Glyph } from '../../src/icons';
import { useAppContext, BUCKETS, BUCKET_COLOR } from '../../src/context';
import { Header } from '../../src/components/Header';

export default function CategoryList() {
  const s = useAppContext();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const budgeted = s.budgets.map((b) => b.id);
  const groups = BUCKETS.filter((bk) => bk !== 'Income')
    .map((bk) => ({ label: bk, color: BUCKET_COLOR[bk], items: s.categories.filter((c) => c.bucket === bk) }))
    .filter((g) => g.items.length);

  return (
    <View style={{ flex: 1, paddingTop: insets.top + 6 }}>
      <Header title="Categories" />
      <ScrollView contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: insets.bottom + 30 }} showsVerticalScrollIndicator={false}>
        {s.categories.length === 0 && (
          <Text style={styles.emptyText}>
            {s.categoriesLoading ? 'Loading categories…' : 'No categories yet.'}
          </Text>
        )}
        {groups.map((g) => (
          <View key={g.label} style={{ marginBottom: 8 }}>
            <View style={styles.bucketHead}>
              <View style={[styles.bucketDot, { backgroundColor: g.color }]} />
              <Text style={styles.bucketLabel}>{g.label}</Text>
            </View>
            {g.items.map((c) => (
              <Pressable key={c.id} onPress={() => router.push(`/category/edit?catId=${c.id}`)} style={styles.row}>
                <View style={[styles.chip, { backgroundColor: tint(c.color, 0.15) }]}><Icon name={c.icon} size={20} color={c.color} /></View>
                <Text style={styles.name}>{c.name}</Text>
                {budgeted.includes(c.id) && <Text style={styles.budgeted}>budgeted</Text>}
                <Glyph name="chevron" size={18} color={C.textFaint} />
              </Pressable>
            ))}
          </View>
        ))}

        <Pressable onPress={() => router.push('/category/edit')} style={styles.newBtn}>
          <Glyph name="plus" size={18} color={C.accentSoft} />
          <Text style={styles.newText}>New category</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  emptyText: { fontFamily: FONT.body, fontSize: 14, color: C.textMid, textAlign: 'center', marginTop: 28 },
  bucketHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 4, marginTop: 14, marginBottom: 8 },
  bucketDot: { width: 8, height: 8, borderRadius: 4 },
  bucketLabel: { fontFamily: FONT.body, fontSize: 12.5, fontWeight: '700', color: C.textMid, letterSpacing: 0.3 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 13, backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 14, paddingVertical: 13, paddingHorizontal: 14, marginBottom: 8 },
  chip: { width: 38, height: 38, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  name: { flex: 1, fontFamily: FONT.body, fontSize: 15, fontWeight: '600', color: C.textBright },
  budgeted: { fontFamily: FONT.body, fontSize: 11, fontWeight: '600', color: C.accentSoft, backgroundColor: 'rgba(124,140,255,.14)', paddingVertical: 3, paddingHorizontal: 8, borderRadius: 7 },
  newBtn: { marginTop: 8, paddingVertical: 16, borderWidth: 1, borderStyle: 'dashed', borderColor: 'rgba(124,140,255,.4)', backgroundColor: 'rgba(124,140,255,.07)', borderRadius: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  newText: { fontFamily: FONT.body, fontSize: 15, fontWeight: '600', color: C.accentSoft },
});
