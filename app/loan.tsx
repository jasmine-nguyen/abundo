import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { C, FONT, fmtCompact } from '../src/theme';
import { useAppContext } from '../src/context';
import { useLoanFactsQuery, useRepaymentQuery, useIsAuthed } from '../src/queries';
import { Header } from '../src/components/Header';
import { DetailStates } from '../src/components/DetailStates';
import { NativeDateField } from '../src/components/NativeDateField';
import { MoneyField } from '../src/components/MoneyField';
import { parseAmount, numText } from '../src/numutil';
import { LOANFACTS_FIELD_MAX } from '../src/loanLimits';
import type { LoanFacts, LoanFactsInput } from '../src/api';

export default function Loan() {
  const insets = useSafeAreaInsets();
  // WHIT-203: the form reads the cached loan-facts query. WHIT-819: it only mounts once the
  // saved facts have loaded, so it can never open blank and overwrite them on save.
  const authed = useIsAuthed();
  const loanFactsQuery = useLoanFactsQuery(authed);
  // WHIT-821: the last repayment pre-fills Scheduled repayment. Wait for its first load so the
  // seed isn't missed; a failed read doesn't block the form.
  const repaymentQuery = useRepaymentQuery(authed);

  return (
    <View style={{ flex: 1, paddingTop: insets.top + 6 }}>
      <Header title="Loan details" />
      <DetailStates
        isLoading={loanFactsQuery.isLoading}
        isError={loanFactsQuery.isError}
        hasCache={loanFactsQuery.data !== undefined}
        idPrefix="loan-facts"
        errorText="Couldn't load your loan details."
        retryLabel="Retry loading your loan details"
        onRetry={() => loanFactsQuery.refetch()}
      >
        {loanFactsQuery.data && !repaymentQuery.isLoading && (
          <LoanForm facts={loanFactsQuery.data} lastRepayment={repaymentQuery.data?.amount ?? null} />
        )}
      </DetailStates>
    </View>
  );
}

function LoanForm({ facts: f, lastRepayment }: { facts: LoanFacts; lastRepayment: number | null }) {
  const s = useAppContext(); // showToast + saveLoanFacts (write) stay on the store
  const insets = useSafeAreaInsets();
  const router = useRouter();

  // Seed each input from the saved facts (empty when unset).
  const [original, setOriginal] = useState(numText(f.original));
  const [homeValue, setHomeValue] = useState(numText(f.homeValue));
  const [lvr, setLvr] = useState(f.lvr == null ? '' : String(f.lvr * 100));
  const [ratePct, setRatePct] = useState(numText(f.ratePct));
  const [baseRepay, setBaseRepay] = useState(numText(f.baseRepay ?? lastRepayment));
  const prefilledRepay = f.baseRepay == null && lastRepayment != null;
  const [extra, setExtra] = useState(numText(f.extra));
  const [payoffGoalDate, setPayoffGoalDate] = useState<string | null>(f.payoffGoalDate ?? null);
  const [depositTarget, setDepositTarget] = useState(numText(f.depositTarget));
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
      // Optional (WHIT-378): the user's next-place deposit target. Blank => null (unset);
      // when filled it must be a valid positive amount, checked below.
      depositTarget: depositTarget.trim() === '' ? null : parseAmount(depositTarget),
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
    // Ceiling guard: the server rejects any dollar field above LOANFACTS_FIELD_MAX. Warn here
    // with a specific message rather than letting it 400 into the generic save-error toast.
    // The figure comes from the constant (WHIT-393) so the wording can't outlive a ceiling
    // change; "or less" because the guard is strict > — exactly the ceiling is allowed.
    if ([next.original, next.homeValue, next.baseRepay, next.extra].some((v) => v > LOANFACTS_FIELD_MAX)) {
      s.showToast(`Keep each amount to ${fmtCompact(LOANFACTS_FIELD_MAX)} or less.`);
      return;
    }
    // The deposit target is optional, but a filled-in value must be a valid amount > 0.
    if (next.depositTarget != null && !(Number.isFinite(next.depositTarget) && next.depositTarget > 0)) {
      s.showToast('Enter a valid deposit target, or leave it blank.');
      return;
    }
    if (next.depositTarget != null && next.depositTarget > LOANFACTS_FIELD_MAX) {
      s.showToast(`Keep the deposit target to ${fmtCompact(LOANFACTS_FIELD_MAX)} or less.`);
      return;
    }
    setSaving(true);
    const saved = await s.saveLoanFacts(next);
    setSaving(false);
    if (saved) router.back();
  };

  return (
    <ScrollView
      contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: insets.bottom + 40 }}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      // The keyboard opens over the Save button at the bottom — inset the scroll by the
      // keyboard height so it scrolls into reach (iOS), and let a tap on Save land.
      automaticallyAdjustKeyboardInsets
    >
      <Text style={styles.intro}>
        Add your loan facts so Abundo can show real progress and equity. We only ask for what the bank feed can't tell us.
      </Text>

      <MoneyField label="Original loan amount" hint="What you first borrowed" placeholder="e.g. 500000" prefix="$" value={original} onChangeText={setOriginal} {...loanLook} />
      <MoneyField label="Property value" hint="What it's worth today" placeholder="e.g. 650000" prefix="$" value={homeValue} onChangeText={setHomeValue} {...loanLook} />
      <MoneyField label="Loan-to-value ratio" hint="How much the bank lends against it — usually 80" placeholder="e.g. 80" suffix="%" value={lvr} onChangeText={setLvr} {...loanLook} />
      <MoneyField label="Interest rate" hint="Your current rate" placeholder="e.g. 6.2" suffix="%" value={ratePct} onChangeText={setRatePct} {...loanLook} />
      <MoneyField
        label="Scheduled repayment"
        hint={prefilledRepay ? "From your last repayment — check it's your monthly minimum" : 'Your minimum, per month'}
        placeholder="e.g. 2500"
        prefix="$"
        value={baseRepay}
        onChangeText={setBaseRepay}
        {...loanLook}
      />
      <MoneyField label="Extra repayment" hint="Optional top-up per month" placeholder="e.g. 200" prefix="$" value={extra} onChangeText={setExtra} {...loanLook} />

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

      <MoneyField label="Deposit needed for your next place" hint="Optional — sets the target the equity card tracks toward." placeholder="e.g. 100000" prefix="$" value={depositTarget} onChangeText={setDepositTarget} {...loanLook} />

      <Pressable onPress={onSave} disabled={saving} style={[styles.save, saving && { opacity: 0.6 }]}>
        <Text style={styles.saveText}>{saving ? 'Saving…' : 'Save loan details'}</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  intro: { fontFamily: FONT.body, fontSize: 13.5, color: C.textDim, lineHeight: 20, marginBottom: 18 },
  field: { marginBottom: 16 },
  label: { fontFamily: FONT.body, fontSize: 13.5, fontWeight: '700', color: C.textBright, marginBottom: 7 },
  hint: { fontFamily: FONT.body, fontSize: 11.5, color: C.textFaint, marginTop: 5 },
  save: { marginTop: 8, paddingVertical: 15, borderRadius: 14, backgroundColor: C.accent, alignItems: 'center' },
  saveText: { fontFamily: FONT.body, fontSize: 15, fontWeight: '700', color: C.accentInk },
});

const loanLook = { labelStyle: styles.label, style: styles.field };
