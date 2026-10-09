import { View, Text, Pressable, StyleSheet, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, FONT, tint } from '../../src/theme';
import { Icon } from '../../src/icons';
import { useBudgetsScreenData, useCategories } from '../../src/queries';
import { Header } from '../../src/components/Header';

export default function BudgetPick() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  // WHIT-203: budgets + the pickable category list come from the cached query layer.
  const { budgets } = useBudgetsScreenData();
  const { categories } = useCategories();
  const budgeted = budgets.map((b) => b.id);
  // Income categories are pickable too: their budget is an earn-target / floor
  // (over-is-good, WHIT-69), not a spend ceiling. Savings is NOT budgetable here:
  // savings is an account balance, not categorised spend, so a Savings target renders
  // a permanently-empty bar — excluded until a real account-balance goal exists (WHIT-201).
  const list = categories.filter((c) => !budgeted.includes(c.id) && c.bucket !== 'Savings');

  return (
    <View style={{ flex: 1, paddingTop: insets.top + 6 }}>
      <Header title="Add a budget" />
      <ScrollView contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: insets.bottom + 30 }} showsVerticalScrollIndicator={false}>
        <Text style={styles.title}>Kick things off by <Text style={{ color: C.accentSoft }}>picking a category to budget</Text></Text>
        <Text style={styles.sub}>These categories don't have a budget yet.</Text>

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
            {/* Income's budget is an earn-target (a floor), not a spend ceiling (WHIT-69). */}
            {c.bucket === 'Income' && <Text style={styles.earnTag}>earn-target</Text>}
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  title: { fontFamily: FONT.display, fontSize: 24, fontWeight: '700', color: C.text, lineHeight: 30, letterSpacing: -0.4, paddingHorizontal: 2, paddingTop: 4 },
  sub: { fontFamily: FONT.body, fontSize: 13.5, color: C.textDim, marginHorizontal: 2, marginTop: 10, marginBottom: 16 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 13, paddingVertical: 14, paddingHorizontal: 14, backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 16, marginBottom: 10 },
  chip: { width: 42, height: 42, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  name: { fontFamily: FONT.body, fontSize: 15, fontWeight: '600', color: C.textBright },
  bucket: { fontFamily: FONT.body, fontSize: 12.5, color: C.textDim, marginTop: 2 },
  earnTag: { fontFamily: FONT.body, fontSize: 11.5, fontWeight: '600', color: C.good, backgroundColor: tint(C.good, 0.12), borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3, overflow: 'hidden' },
  empty: { alignItems: 'center', paddingVertical: 50, paddingHorizontal: 24 },
  emptyText: { fontFamily: FONT.body, fontSize: 14, color: C.textDim, textAlign: 'center' },
});
