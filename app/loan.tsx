import React, { useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { C, FONT } from '../src/theme';
import { useAppContext, EMPTY_LOAN_FACTS } from '../src/context';
import { useLoanFactsQuery, useIsAuthed } from '../src/queries';
import { Header } from '../src/components/Header';
import { NativeDateField } from '../src/components/NativeDateField';
import { parseAmount, numText } from '../src/numutil';
import type { LoanFactsInput } from '../src/api';

export default function Loan() {
  const s = useAppContext(); // showToast + saveLoanFacts (write) stay on the store
  const insets = useSafeAreaInsets();
  const router = useRouter();
  // WHIT-203: seed the form from the cached loan-facts query instead of the eager store.
  const f = useLoanFactsQuery(useIsAuthed()).data ?? EMPTY_LOAN_FACTS;

  // Seed each input from the saved facts (empty when unset). By the time the user
  // reaches this screen the mount fetch has resolved, so these reflect saved data.
  const [original, setOriginal] = useState(numText(f.original));
  const [homeValue, setHomeValue] = useState(numText(f.homeValue));
  const [lvr, setLvr] = useState(f.lvr == null ? '' : String(f.lvr * 100));
  const [ratePct, setRatePct] = useState(numText(f.ratePct));
  const [baseRepay, setBaseRepay] = useState(numText(f.baseRepay));
  const [extra, setExtra] = useState(numText(f.extra));
  const [payoffGoalDate, setPayoffGoalDate] = useState<string | null>(f.payoffGoalDate ?? null);
  const [saving, setSaving] = useState(false);

  // The payoff date can't be in the past; midnight so the seed has no time-of-day.
  const payoffMinDate = new Date();
  payoffMinDate.setHours(0, 0, 0, 0);

  const onSave = async () => {
    const next: LoanFactsInput = {
      original: parseAmount(original),
      homeValue: parseAmount(homeValue),
      lvr: parseAmount(lvr) / 100,          // percent -> fraction
      ratePct: parseAmount(ratePct),
      baseRepay: parseAmount(baseRepay),
      extra: parseAmount(extra),
      // Optional (WHIT-126): null when unset/cleared. The picker only yields valid
      // future ISO dates, so it needs no extra guard and never blocks the save.
      payoffGoalDate,
    };
    // Client-side guard mirroring the server so we fail fast with a clear message
    // instead of a 400 round-trip. extra may be 0 (an optional top-up).
    const positive = [next.original, next.homeValue, next.baseRepay].every((v) => v > 0);
    const ok = positive
      && Number.isFinite(next.extra) && next.extra >= 0
      && next.lvr > 0 && next.lvr <= 1
      && next.ratePct > 0 && next.ratePct <= 100;
    if (!ok) {
      s.showToast('Please fill in every field with a valid amount.');
      return;
    }
    setSaving(true);
    const saved = await s.saveLoanFacts(next);
    setSaving(false);
    if (saved) router.back();
  };

  return (
    <View style={{ flex: 1, paddingTop: insets.top + 6 }}>
      <Header title="Loan details" />
      <ScrollView contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: insets.bottom + 40 }} showsVerticalScrollIndicator={false}>
        <Text style={styles.intro}>
          Add your loan facts so Whittle can show real progress and equity. We only ask for what the bank feed can't tell us.
        </Text>

        <Field label="Original loan amount" hint="What you first borrowed" placeholder="e.g. 600000" prefix="$" value={original} onChangeText={setOriginal} />
        <Field label="Property value" hint="What it's worth today" placeholder="e.g. 770000" prefix="$" value={homeValue} onChangeText={setHomeValue} />
        <Field label="Loan-to-value ratio" hint="How much the bank lends against it — usually 80" placeholder="e.g. 80" suffix="%" value={lvr} onChangeText={setLvr} />
        <Field label="Interest rate" hint="Your current rate" placeholder="e.g. 5.74" suffix="%" value={ratePct} onChangeText={setRatePct} />
        <Field label="Scheduled repayment" hint="Your minimum, per month" placeholder="e.g. 3667" prefix="$" value={baseRepay} onChangeText={setBaseRepay} />
        <Field label="Extra repayment" hint="Optional top-up per month" placeholder="e.g. 500" prefix="$" value={extra} onChangeText={setExtra} />

        <View style={styles.field}>
          <Text style={styles.label}>Target payoff date</Text>
          <NativeDateField
            value={payoffGoalDate}
            onChange={setPayoffGoalDate}
            minimumDate={payoffMinDate}
            clearable
            alwaysShowPillIOS
          />
          <Text style={styles.hint}>Optional — how we work out the repayment needed if the loan won't clear at your current rate.</Text>
        </View>

        <Pressable onPress={onSave} disabled={saving} style={[styles.save, saving && { opacity: 0.6 }]}>
          <Text style={styles.saveText}>{saving ? 'Saving…' : 'Save loan details'}</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

function Field({
  label, hint, placeholder, value, onChangeText, prefix, suffix,
}: {
  label: string; hint: string; placeholder: string; value: string;
  onChangeText: (t: string) => void; prefix?: string; suffix?: string;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.inputRow}>
        {prefix ? <Text style={styles.affix}>{prefix}</Text> : null}
        <TextInput
          style={styles.input}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={C.placeholder}
          keyboardType="decimal-pad"
          inputMode="decimal"
        />
        {suffix ? <Text style={styles.affix}>{suffix}</Text> : null}
      </View>
      <Text style={styles.hint}>{hint}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  intro: { fontFamily: FONT.body, fontSize: 13.5, color: C.textDim, lineHeight: 20, marginBottom: 18 },
  field: { marginBottom: 16 },
  label: { fontFamily: FONT.body, fontSize: 13.5, fontWeight: '700', color: C.textBright, marginBottom: 7 },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 14, paddingHorizontal: 14, height: 50 },
  affix: { fontFamily: FONT.body, fontSize: 16, fontWeight: '600', color: C.textDim },
  input: { flex: 1, fontFamily: FONT.body, fontSize: 16, color: C.text, height: '100%', textAlignVertical: 'center' },
  hint: { fontFamily: FONT.body, fontSize: 11.5, color: C.textFaint, marginTop: 5 },
  save: { marginTop: 8, paddingVertical: 15, borderRadius: 14, backgroundColor: C.accent, alignItems: 'center' },
  saveText: { fontFamily: FONT.body, fontSize: 15, fontWeight: '700', color: C.accentInk },
});
