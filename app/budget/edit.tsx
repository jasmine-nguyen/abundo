import React, { useState, useEffect } from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView, TextInput } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, FONT, tint } from '../../src/theme';
import { Icon, Glyph } from '../../src/icons';
import { useAppContext, budgetEditInfo, cycleName } from '../../src/context';
import { useBudgetsScreenData } from '../../src/queries';
import { queryClient } from '../../src/queryClient';
import { Header } from '../../src/components/Header';
import { useInFlightGuard } from '../../src/hooks/useInFlightGuard';

export default function BudgetEdit() {
  const s = useAppContext(); // saveBudget writer stays on the store
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { categoryId } = useLocalSearchParams<{ categoryId: string; from?: string }>();
  // WHIT-203: the taxonomy + budgets + cycle name feed budgetEditInfo from the query layer.
  const { budgets, category, cycleLen } = useBudgetsScreenData();
  const info = budgetEditInfo({ budgets, category, cycleName: () => cycleName(cycleLen) }, categoryId);
  const [input, setInput] = useState(info.existing ? String(info.existing.budget) : '');
  // WHIT-203: `budgets` may resolve after mount (cold cache), so the useState seed above can
  // miss an existing budget — re-seed the amount when it arrives.
  useEffect(() => {
    if (info.existing) setInput(String(info.existing.budget));
  }, [info.existing?.budget]);
  const [histOpen, setHistOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // WHIT-241: same-frame double-tap guard on Save (must be declared with the other hooks,
  // above the early returns below, to satisfy the rules of hooks).
  const runSave = useInFlightGuard();

  if (!info.category) return <View style={{ flex: 1 }}><Header title="Set budget" /></View>;
  // WHIT-202: a Savings category can't carry a budget target (the Budgets screen skips it),
  // so a deep-link to /budget/edit on one lands here rather than on an amount field whose
  // save is doomed to a server 400. Show a coherent "can't budget" state instead.
  if (info.category.bucket === 'Savings') {
    return (
      <View style={{ flex: 1, paddingTop: insets.top + 6 }}>
        <Header title="Set budget" />
        <ScrollView contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: insets.bottom + 30 }} showsVerticalScrollIndicator={false}>
          <View style={styles.categoryRow}>
            <View style={[styles.chip, { backgroundColor: tint(info.category.color, 0.15) }]}><Icon name={info.category.icon} size={30} color={info.category.color} /></View>
            <View><Text style={styles.categoryName}>{info.category.name}</Text></View>
          </View>
          <Text style={styles.savingsNote}>Savings categories can't be budgeted — they track a goal, not a pay-cycle spend limit.</Text>
        </ScrollView>
      </View>
    );
  }
  const num = parseFloat(input) || 0;
  const canSave = num > 0 && !submitting;

  const save = () => runSave(async () => {
    if (!canSave) return;
    setSubmitting(true);
    const ok = await s.saveBudget(categoryId, num);
    if (ok) {
      // WHIT-188: the Budgets tab now reads the query cache, so mark budgets stale —
      // otherwise the just-saved change wouldn't show until the 45s staleTime elapsed.
      // Prefix key ['budgets'] matches every ['budgets', cycleLen] entry.
      queryClient.invalidateQueries({ queryKey: ['budgets'] });
      router.dismissAll?.();
      router.replace('/(tabs)/budgets');
    } else {
      setSubmitting(false); // stay on the screen so the user can retry
    }
  });

  return (
    <View style={{ flex: 1, paddingTop: insets.top + 6 }}>
      <Header title={info.title} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: insets.bottom + 30 }} showsVerticalScrollIndicator={false}>
        <View style={styles.categoryRow}>
          <View style={[styles.chip, { backgroundColor: tint(info.category.color, 0.15) }]}><Icon name={info.category.icon} size={30} color={info.category.color} /></View>
          <View>
            <Text style={styles.categoryName}>{info.category.name}</Text>
            <Text style={styles.categoryRec}>{info.hasRecommendation ? `Recommended: ${info.recLabel}` : info.recPrompt}</Text>
          </View>
        </View>

        <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
          <View style={styles.stat}><Text style={styles.statLabel}>Last {info.lastWord}</Text><Text style={styles.statValue}>{info.lastLabel}</Text></View>
          <View style={styles.stat}><Text style={styles.statLabel}>6-cycle average</Text><Text style={styles.statValue}>{info.avgLabel}</Text></View>
        </View>

        <Text style={styles.fieldLabel}>{info.periodLabel} BUDGET</Text>
        <View style={styles.amountBox}>
          <Text style={styles.dollar}>$</Text>
          <TextInput value={input} onChangeText={(t) => setInput(t.replace(/[^0-9.]/g, ''))} keyboardType="decimal-pad" placeholder="0" placeholderTextColor={C.placeholder} style={styles.amountInput} />
        </View>

        {info.hasRecommendation && (
          <Pressable onPress={() => setInput(String(info.rec))} style={styles.recBtn}>
            <Text style={styles.recBtnText}>{info.recommendCta}</Text>
            <Text style={styles.recBtnAmount}>{info.recLabel}</Text>
          </Pressable>
        )}

        <Pressable onPress={() => setHistOpen((v) => !v)} style={styles.histToggle}>
          <Text style={styles.histToggleText}>{info.historyToggleLabel}</Text>
          <View style={{ transform: [{ rotate: histOpen ? '180deg' : '0deg' }] }}>
            <Glyph name="chevronDown" size={20} color={C.textMid} />
          </View>
        </Pressable>

        {histOpen && (
          <View style={styles.hist}>
            {info.histBars.map((h, i) => (
              <View key={i} style={styles.histCol}>
                <View style={{ width: 18, height: h.h, borderRadius: 5, backgroundColor: h.last ? C.accent : 'rgba(124,140,255,.32)' }} />
                <Text style={styles.histLabel}>{h.label}</Text>
              </View>
            ))}
          </View>
        )}

        <Pressable onPress={save} style={[styles.saveBtn, { backgroundColor: canSave ? C.accent : 'rgba(124,140,255,.25)' }]}>
          <Text style={[styles.saveText, { color: canSave ? C.accentInk : '#6a6a90' }]}>{info.saveText}</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  categoryRow: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingTop: 4 },
  chip: { width: 56, height: 56, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  categoryName: { fontFamily: FONT.display, fontSize: 20, fontWeight: '700', color: C.text, letterSpacing: -0.3 },
  categoryRec: { fontFamily: FONT.body, fontSize: 13, color: C.accentSoft, marginTop: 3 },
  savingsNote: { fontFamily: FONT.body, fontSize: 14, lineHeight: 20, color: C.textMid, marginTop: 22 },
  stat: { flex: 1, backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 14, padding: 13 },
  statLabel: { fontFamily: FONT.body, fontSize: 12, color: C.textDim },
  statValue: { fontFamily: FONT.display, fontSize: 18, fontWeight: '700', color: C.text, marginTop: 4 },
  fieldLabel: { fontFamily: FONT.body, fontSize: 12, fontWeight: '700', color: C.textMid, letterSpacing: 0.3, marginTop: 20, marginBottom: 8, marginHorizontal: 2 },
  amountBox: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.card, borderWidth: 1, borderColor: 'rgba(255,255,255,.08)', borderRadius: 16, paddingHorizontal: 18 },
  dollar: { fontFamily: FONT.display, fontSize: 28, fontWeight: '700', color: C.textMid },
  amountInput: { flex: 1, fontFamily: FONT.display, fontSize: 30, fontWeight: '800', color: '#fff', paddingVertical: 16, marginLeft: 4 },
  recBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: 'rgba(124,140,255,.1)', borderWidth: 1, borderColor: 'rgba(124,140,255,.22)', borderRadius: 14, paddingVertical: 13, paddingHorizontal: 16, marginTop: 12 },
  recBtnText: { fontFamily: FONT.body, fontSize: 14.5, fontWeight: '600', color: C.accentSofter },
  recBtnAmount: { fontFamily: FONT.display, fontSize: 15, fontWeight: '700', color: '#fff' },
  histToggle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 16, marginTop: 4 },
  histToggleText: { fontFamily: FONT.body, fontSize: 14.5, fontWeight: '600', color: C.textBright },
  hist: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', height: 120, backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 16, paddingHorizontal: 18, paddingVertical: 14 },
  histCol: { alignItems: 'center', gap: 8 },
  histLabel: { fontFamily: FONT.body, fontSize: 11, color: C.textDim },
  saveBtn: { marginTop: 20, paddingVertical: 16, borderRadius: 15, alignItems: 'center' },
  saveText: { fontFamily: FONT.body, fontSize: 16, fontWeight: '700' },
});
