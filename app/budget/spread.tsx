import React, { useState, useEffect } from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView, TextInput } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, FONT, tint, fmtExact } from '../../src/theme';
import { Icon } from '../../src/icons';
import { useAppContext, spreadPreview, SPREAD_MIN_CYCLES, SPREAD_MAX_CYCLES } from '../../src/context';
import type { Category } from '../../src/context';
import { useBudgetsScreenData } from '../../src/queries';
import { Header } from '../../src/components/Header';
import { useInFlightGuard } from '../../src/hooks/useInFlightGuard';

// Keep only digits and a SINGLE decimal point, so what's shown always matches what parseFloat
// saves (a stray second dot in "5.5.5" would otherwise display but save 5.5).
function cleanAmount(text: string): string {
  const digitsAndDots = text.replace(/[^0-9.]/g, '');
  const firstDot = digitsAndDots.indexOf('.');
  if (firstDot === -1) return digitsAndDots;
  return digitsAndDots.slice(0, firstDot + 1) + digitsAndDots.slice(firstDot + 1).replace(/\./g, '');
}

// Spread a one-off bill over the coming pay cycles (WHIT-505). Reached from the budget detail
// screen: "Spread this bill" (over budget, no plan — prefilled with the overspend) or
// "Edit or remove spread" (a plan is active). The server owns the maths; this just collects
// an amount + a cycle count and shows a preview that matches the server's whole-cent split.
export default function BudgetSpread() {
  const s = useAppContext();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { categoryId, prefill } = useLocalSearchParams<{ categoryId: string; prefill?: string }>();
  const { budgets, category } = useBudgetsScreenData();
  const cat = category(categoryId);
  const existing = budgets.find((b) => b.id === categoryId);
  const plan = existing?.spread;

  const [amount, setAmount] = useState(plan ? String(plan.amount) : (prefill ?? ''));
  const [cycles, setCycles] = useState(plan?.cycles ?? 3);
  const [submitting, setSubmitting] = useState(false);
  // `budgets` can resolve after mount (cold cache), so re-seed from an active plan when it lands.
  useEffect(() => {
    if (plan) { setAmount(String(plan.amount)); setCycles(plan.cycles); }
  }, [plan?.amount, plan?.cycles]);
  const runSave = useInFlightGuard();
  const runRemove = useInFlightGuard();

  if (!cat) return <View style={{ flex: 1 }}><Header title="Spread a bill" /></View>;
  // A bill spread is spend-only (server rejects Income/Savings). Guard the deep-link so the
  // user lands on a coherent state rather than a doomed save.
  if (cat.bucket === 'Savings' || cat.bucket === 'Income') {
    return <SpreadNotice cat={cat} insets={insets} note="Only spend categories can spread a bill." />;
  }

  // No budget target for this category yet → a save would 400 (the server spreads against a
  // target), and a list-render→navigate race can land here before one exists (WHIT-556). Guide
  // the user rather than dead-ending on a doomed save. Sits after all hooks + the bucket guard.
  if (!existing) {
    return (
      <SpreadNotice
        cat={cat} insets={insets} noteTestID="spread-no-budget"
        note="Set a budget for this category before spreading a bill."
      />
    );
  }

  const num = parseFloat(amount) || 0;
  const preview = spreadPreview(num, cycles);
  const canSave = num > 0 && cycles >= SPREAD_MIN_CYCLES && cycles <= SPREAD_MAX_CYCLES && !submitting;
  const stepCycles = (delta: number) =>
    setCycles((n) => Math.max(SPREAD_MIN_CYCLES, Math.min(SPREAD_MAX_CYCLES, n + delta)));

  const save = () => runSave(async () => {
    if (!canSave) return;
    setSubmitting(true);
    try {
      const ok = await s.saveSpread(categoryId, num, cycles);
      // saveSpread invalidates ['budgets'] itself, so the screen just navigates on success.
      if (ok) router.back();
      else setSubmitting(false); // stay on the screen so the user can retry
    } catch (error) {
      setSubmitting(false);
      throw error;
    }
  });

  const remove = () => runRemove(async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const ok = await s.removeSpread(categoryId);
      if (ok) router.back();
      else setSubmitting(false);
    } catch (error) {
      setSubmitting(false);
      throw error;
    }
  });

  const sliceLabel = preview.firstSlice === preview.lastSlice
    ? `${fmtExact(preview.firstSlice)}`
    : `${fmtExact(preview.lastSlice)}–${fmtExact(preview.firstSlice)}`;

  return (
    <View style={{ flex: 1, paddingTop: insets.top + 6 }}>
      <Header title={plan ? 'Edit bill spread' : 'Spread a bill'} />
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: insets.bottom + 30 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
      >
        <View style={styles.categoryRow}>
          <View style={[styles.chip, { backgroundColor: tint(cat.color, 0.15) }]}><Icon name={cat.icon} size={30} color={cat.color} /></View>
          <View>
            <Text style={styles.categoryName}>{cat.name}</Text>
            <Text style={styles.categorySub}>Cover the bill now, pay it back over the next few cycles.</Text>
          </View>
        </View>

        <Text style={styles.fieldLabel}>BILL AMOUNT</Text>
        <View style={styles.amountBox}>
          <Text style={styles.dollar}>$</Text>
          <TextInput
            testID="spread-amount"
            value={amount}
            onChangeText={(t) => setAmount(cleanAmount(t))}
            keyboardType="decimal-pad"
            placeholder="0"
            placeholderTextColor={C.placeholder}
            style={styles.amountInput}
          />
        </View>

        <Text style={styles.fieldLabel}>SPREAD OVER</Text>
        <View style={styles.stepperRow}>
          <Pressable testID="spread-cycles-minus" onPress={() => stepCycles(-1)} disabled={cycles <= SPREAD_MIN_CYCLES} style={[styles.stepBtn, cycles <= SPREAD_MIN_CYCLES && styles.stepBtnOff]}>
            <Text style={styles.stepBtnText}>−</Text>
          </Pressable>
          <View style={styles.stepValue}>
            <Text style={styles.stepValueNum}>{cycles}</Text>
            <Text style={styles.stepValueUnit}>{cycles === 1 ? 'cycle' : 'cycles'}</Text>
          </View>
          <Pressable testID="spread-cycles-plus" onPress={() => stepCycles(1)} disabled={cycles >= SPREAD_MAX_CYCLES} style={[styles.stepBtn, cycles >= SPREAD_MAX_CYCLES && styles.stepBtnOff]}>
            <Text style={styles.stepBtnText}>+</Text>
          </Pressable>
        </View>

        {num > 0 && (
          <View testID="spread-preview" style={styles.previewBox}>
            <Text style={styles.previewLine}>+{fmtExact(preview.cushion)} added to this cycle</Text>
            <Text style={styles.previewSub}>then {sliceLabel} taken back for {cycles} {cycles === 1 ? 'cycle' : 'cycles'}</Text>
          </View>
        )}

        <Pressable testID="spread-save" onPress={save} style={[styles.saveBtn, { backgroundColor: canSave ? C.accent : tint(C.accentAlt, 0.25) }]}>
          <Text style={[styles.saveText, { color: canSave ? C.accentInk : '#6a6a90' }]}>{plan ? 'Update spread' : 'Spread this bill'}</Text>
        </Pressable>

        {plan && (
          <Pressable testID="spread-remove" onPress={remove} disabled={submitting} style={[styles.removeBtn, submitting && { opacity: 0.6 }]}>
            <Text style={styles.removeText}>Remove spread</Text>
          </Pressable>
        )}
      </ScrollView>
    </View>
  );
}

// A coherent "can't spread here" state for the deep-link guards (wrong bucket / no budget target):
// the category chip + name and a one-line note, instead of dead-ending on a doomed save.
function SpreadNotice({ cat, insets, note, noteTestID }: {
  cat: Category;
  insets: { top: number; bottom: number };
  note: string;
  noteTestID?: string;
}) {
  return (
    <View style={{ flex: 1, paddingTop: insets.top + 6 }}>
      <Header title="Spread a bill" />
      <ScrollView contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: insets.bottom + 30 }} showsVerticalScrollIndicator={false}>
        <View style={styles.categoryRow}>
          <View style={[styles.chip, { backgroundColor: tint(cat.color, 0.15) }]}><Icon name={cat.icon} size={30} color={cat.color} /></View>
          <View><Text style={styles.categoryName}>{cat.name}</Text></View>
        </View>
        <Text testID={noteTestID} style={styles.note}>{note}</Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  categoryRow: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingTop: 4 },
  chip: { width: 56, height: 56, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  categoryName: { fontFamily: FONT.display, fontSize: 20, fontWeight: '700', color: C.text, letterSpacing: -0.3 },
  categorySub: { fontFamily: FONT.body, fontSize: 13, color: C.textDim, marginTop: 3, maxWidth: 260 },
  note: { fontFamily: FONT.body, fontSize: 14, lineHeight: 20, color: C.textMid, marginTop: 22 },
  fieldLabel: { fontFamily: FONT.body, fontSize: 12, fontWeight: '700', color: C.textMid, letterSpacing: 0.3, marginTop: 20, marginBottom: 8, marginHorizontal: 2 },
  amountBox: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.card, borderWidth: 1, borderColor: 'rgba(255,255,255,.08)', borderRadius: 16, paddingHorizontal: 18 },
  dollar: { fontFamily: FONT.display, fontSize: 28, fontWeight: '700', color: C.textMid },
  amountInput: { flex: 1, fontFamily: FONT.display, fontSize: 30, fontWeight: '800', color: '#fff', paddingVertical: 16, marginLeft: 4 },
  stepperRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  stepBtn: { width: 56, height: 56, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline },
  stepBtnOff: { opacity: 0.4 },
  stepBtnText: { fontFamily: FONT.display, fontSize: 28, fontWeight: '800', color: C.textBright },
  stepValue: { flex: 1, alignItems: 'center', backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 16, paddingVertical: 10 },
  stepValueNum: { fontFamily: FONT.display, fontSize: 26, fontWeight: '800', color: '#fff' },
  stepValueUnit: { fontFamily: FONT.body, fontSize: 12, color: C.textDim, marginTop: 1 },
  previewBox: { backgroundColor: tint(C.accentAlt, 0.1), borderWidth: 1, borderColor: tint(C.accentAlt, 0.22), borderRadius: 14, padding: 16, marginTop: 18 },
  previewLine: { fontFamily: FONT.display, fontSize: 16, fontWeight: '700', color: C.accentSofter },
  previewSub: { fontFamily: FONT.body, fontSize: 13.5, color: C.textMid, marginTop: 4 },
  saveBtn: { marginTop: 22, paddingVertical: 16, borderRadius: 15, alignItems: 'center' },
  saveText: { fontFamily: FONT.body, fontSize: 16, fontWeight: '700' },
  removeBtn: { marginTop: 14, paddingVertical: 15, borderRadius: 15, borderWidth: 1, borderColor: 'rgba(255,107,107,.3)', backgroundColor: 'rgba(255,107,107,.08)', alignItems: 'center' },
  removeText: { fontFamily: FONT.body, fontSize: 15, fontWeight: '600', color: C.bad },
});
