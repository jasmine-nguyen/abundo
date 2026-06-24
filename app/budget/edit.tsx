import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView, TextInput } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, FONT, tint } from '../../src/theme';
import { Icon, Glyph } from '../../src/icons';
import { useStore, budgetEditInfo } from '../../src/store';
import { Header } from '../../src/components/Header';

export default function BudgetEdit() {
  const s = useStore();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { catId } = useLocalSearchParams<{ catId: string; from?: string }>();
  const info = budgetEditInfo(s, catId);
  const [input, setInput] = useState(info.existing ? String(info.existing.budget) : '');
  const [histOpen, setHistOpen] = useState(false);

  if (!info.cat) return <View style={{ flex: 1 }}><Header title="Set budget" /></View>;
  const num = parseFloat(input) || 0;
  const canSave = num > 0;

  const save = () => {
    if (!canSave) return;
    s.saveBudget(catId, num);
    router.dismissAll?.();
    router.replace('/(tabs)/budgets');
  };

  return (
    <View style={{ flex: 1, paddingTop: insets.top + 6 }}>
      <Header title={info.title} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: insets.bottom + 30 }} showsVerticalScrollIndicator={false}>
        <View style={styles.catRow}>
          <View style={[styles.chip, { backgroundColor: tint(info.cat.color, 0.15) }]}><Icon name={info.cat.icon} size={30} color={info.cat.color} /></View>
          <View>
            <Text style={styles.catName}>{info.cat.name}</Text>
            <Text style={styles.catRec}>Recommended: {info.recLabel}</Text>
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

        <Pressable onPress={() => setInput(String(info.rec))} style={styles.recBtn}>
          <Text style={styles.recBtnText}>{info.recommendCta}</Text>
          <Text style={styles.recBtnAmount}>{info.recLabel}</Text>
        </Pressable>

        <Pressable onPress={() => setHistOpen((v) => !v)} style={styles.histToggle}>
          <Text style={styles.histToggleText}>View spending history</Text>
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
  catRow: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingTop: 4 },
  chip: { width: 56, height: 56, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  catName: { fontFamily: FONT.display, fontSize: 20, fontWeight: '700', color: C.text, letterSpacing: -0.3 },
  catRec: { fontFamily: FONT.body, fontSize: 13, color: C.accentSoft, marginTop: 3 },
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
