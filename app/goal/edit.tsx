import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { C, FONT, fmt } from '../../src/theme';
import { Icon, ICON_KEYS } from '../../src/icons';
import { useAppContext, accountSummaries } from '../../src/context';
import { useGoalsQuery, useTransactionsScreenData, useIsAuthed } from '../../src/queries';
import { Header } from '../../src/components/Header';
import { NativeDateField } from '../../src/components/NativeDateField';
import { useInFlightGuard } from '../../src/hooks/useInFlightGuard';
import { toISODate } from '../../src/dateutil';
import { parseAmount, numText } from '../../src/numutil';
import type { GoalWriteBody } from '../../src/api';

type Direction = 'grow' | 'paydown';
type Source = 'synced' | 'manual';

// The add/edit goal form (WHIT-234). Fleshes out the WHIT-233 stub. A pushed screen reached
// from the Goals hub: `/goal/edit` to create, `/goal/edit?id=<goal>` to edit. Mirrors the
// app/loan.tsx form + app/category/edit.tsx create-vs-edit-and-delete conventions.
export default function GoalEdit() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const s = useAppContext(); // saveGoal / deleteGoal writers + showToast
  const { id } = useLocalSearchParams<{ id?: string }>();
  const editing = typeof id === 'string' && id.length > 0;

  // Hydration source: the ['goals'] cache the hub already keeps warm (the same query the
  // writer optimistically updates). undefined while creating, or before a cold cache resolves.
  const existing = useGoalsQuery(useIsAuthed()).data?.find((goal) => goal.id === id);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayISO = toISODate(today);

  const [name, setName] = useState(existing?.name ?? '');
  const [icon, setIcon] = useState(existing?.icon ?? 'star');
  const [direction, setDirection] = useState<Direction>(existing?.direction ?? 'grow');
  const [source, setSource] = useState<Source | null>(sourceOf(existing));
  const [accountId, setAccountId] = useState<string | null>(existing?.account_id ?? null);
  const [manualBalance, setManualBalance] = useState(numText(existing?.manual_balance));
  const [manualAsOf, setManualAsOf] = useState(existing?.manual_as_of ?? todayISO);
  const [targetAmount, setTargetAmount] = useState(numText(existing?.target_amount));
  const [targetDate, setTargetDate] = useState<string | null>(existing?.target_date ?? null);
  const [baseline, setBaseline] = useState(numText(existing?.baseline));
  const [saving, setSaving] = useState(false);

  // The useState seeds run once, but on the query layer `existing` may resolve a beat AFTER
  // mount (cold cache / deep-link). Re-seed ONCE when it first arrives so an edit never shows —
  // or SAVES — a blank "create" form over a real goal. The `seeded` latch means a LATER
  // background refetch can't clobber what the user is mid-editing (unlike category/edit.tsx:31).
  const seeded = useRef(false);
  useEffect(() => {
    if (!existing || seeded.current) return;
    seeded.current = true;
    setName(existing.name);
    setIcon(existing.icon);
    setDirection(existing.direction);
    setSource(sourceOf(existing));
    setAccountId(existing.account_id ?? null);
    setManualBalance(numText(existing.manual_balance));
    setManualAsOf(existing.manual_as_of ?? todayISO);
    setTargetAmount(numText(existing.target_amount));
    setTargetDate(existing.target_date);
    setBaseline(numText(existing.baseline));
  }, [existing, todayISO]);

  // The synced-account options: the linked accounts we actually hold a live balance for (the
  // true set of synced accounts — an account with a balance but no transactions still appears),
  // named from the transaction feed (accountSummaries is the only source of account names).
  const { transactions, balances } = useTransactionsScreenData();
  const nameById = new Map(accountSummaries({ transactions }).map((a) => [a.id, a.name]));
  const accountOptions: { id: string; name: string; amount: number | null }[] = [...balances.values()].map((b) => ({
    id: b.account_id,
    name: nameById.get(b.account_id) ?? b.account_id,
    amount: b.amount,
  }));
  // Keep the currently-saved account visible when editing, even if it hasn't been polled this
  // session (so it isn't in `balances`) — otherwise the edit form would show no selection.
  if (accountId && !accountOptions.some((o) => o.id === accountId)) {
    accountOptions.push({ id: accountId, name: nameById.get(accountId) ?? accountId, amount: null });
  }

  const chooseDirection = (next: Direction) => {
    setDirection(next);
    // Debt defaults to $0 (pay it all off), editable — seed it when switching to pay-down and
    // the amount is still blank, so the field isn't empty-invalid by surprise. Clear that seeded
    // 0 on the way back to grow, since grow rejects a $0 target.
    if (next === 'paydown' && targetAmount.trim() === '') setTargetAmount('0');
    if (next === 'grow' && targetAmount.trim() === '0') setTargetAmount('');
  };

  // Block save while editing a goal whose cache hasn't loaded yet — otherwise a save would
  // write the default fields back over the real ones (mirrors category/edit.tsx:77).
  const editingUnloaded = editing && !existing;

  // One in-flight latch shared by Save AND Delete: a same-frame Delete-then-Save (or vice
  // versa) on the same goal fires only the first, so the two writers can't race each other.
  const runAction = useInFlightGuard();
  const onSave = () => runAction(async () => {
    if (editingUnloaded || saving) return;

    if (name.trim() === '') return s.showToast('Give your goal a name.');
    if (source == null) return s.showToast("Choose where this goal's balance comes from.");

    const amount = parseAmount(targetAmount);
    if (direction === 'grow' && !(amount > 0)) return s.showToast('Enter a target amount above $0.');
    if (direction === 'paydown' && !(amount >= 0)) return s.showToast('Enter a target amount.');

    if (targetDate == null) return s.showToast('Pick a target date.');

    // Baseline (optional): the starting point the progress bar measures from. For a grow goal
    // it must sit BELOW the target; for a pay-down goal it's the starting balance owed, ABOVE
    // the target. Off the wrong side leaves a permanently 0% bar (context.tsx:1084/1087).
    let baselineValue: number | null = null;
    if (baseline.trim() !== '') {
      baselineValue = parseAmount(baseline);
      if (!(baselineValue >= 0)) return s.showToast('Enter a valid starting amount.');
      if (direction === 'grow' && !(baselineValue < amount)) return s.showToast('The starting amount should be below your target.');
      if (direction === 'paydown' && !(baselineValue > amount)) return s.showToast('The starting amount should be above your target.');
    }

    const common = { name: name.trim(), icon, direction, target_amount: amount, target_date: targetDate, baseline: baselineValue };

    let body: GoalWriteBody;
    if (source === 'synced') {
      if (accountId == null) return s.showToast('Pick an account to track.');
      body = { ...common, account_id: accountId };
    } else {
      const startBalance = parseAmount(manualBalance);
      if (!(startBalance >= 0)) return s.showToast('Enter a starting balance.');
      body = { ...common, manual_balance: startBalance, manual_as_of: manualAsOf };
    }

    setSaving(true);
    try {
      const ok = await s.saveGoal(editing ? id! : null, body);
      setSaving(false);
      if (ok) router.back();
    } catch (error) {
      setSaving(false); // WHIT-249: re-enable on an unexpected throw; re-throw so the guard logs it
      throw error;
    }
  });

  const onDelete = () => runAction(async () => {
    if (!editing || saving) return;
    setSaving(true);
    try {
      const ok = await s.deleteGoal(id!);
      if (ok) router.back();
      else setSaving(false);
    } catch (error) {
      setSaving(false); // WHIT-249: re-enable on an unexpected throw; re-throw so the guard logs it
      throw error;
    }
  });

  const grow = direction === 'grow';

  return (
    <View style={{ flex: 1, paddingTop: insets.top + 6 }}>
      <Header title={editing ? 'Edit goal' : 'Add a goal'} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: insets.bottom + 40 }} showsVerticalScrollIndicator={false}>
        <Text style={styles.label}>NAME</Text>
        <TextInput
          style={styles.input}
          value={name}
          onChangeText={setName}
          placeholder="e.g. Emergency fund"
          placeholderTextColor={C.placeholder}
        />

        <Text style={styles.label}>ICON</Text>
        <View style={styles.iconGrid}>
          {ICON_KEYS.map((key) => {
            const selected = icon === key;
            return (
              <Pressable
                key={key}
                testID={`goal-icon-${key}`}
                onPress={() => setIcon(key)}
                style={[styles.iconBtn, { borderColor: selected ? C.accent : 'rgba(255,255,255,.07)', backgroundColor: selected ? 'rgba(124,140,255,.14)' : C.card }]}
              >
                <Icon name={key} size={22} color={selected ? C.accentSofter : C.textMid} />
              </Pressable>
            );
          })}
        </View>

        <Text style={styles.label}>DIRECTION</Text>
        <View style={styles.segmentRow}>
          <Segment label="Grow (savings)" selected={grow} onPress={() => chooseDirection('grow')} testID="goal-direction-grow" />
          <Segment label="Pay down (debt)" selected={!grow} onPress={() => chooseDirection('paydown')} testID="goal-direction-paydown" />
        </View>

        <Text style={styles.label}>BALANCE SOURCE</Text>
        <View style={styles.segmentRow}>
          <Segment label="Synced account" selected={source === 'synced'} onPress={() => setSource('synced')} testID="goal-source-synced" />
          <Segment label="Manual" selected={source === 'manual'} onPress={() => setSource('manual')} testID="goal-source-manual" />
        </View>

        {source === 'synced' && (
          accountOptions.length === 0 ? (
            <Text style={styles.hint}>No synced accounts yet — link one, or track this goal manually.</Text>
          ) : (
            <View style={styles.accountList}>
              {accountOptions.map((account) => {
                const selected = accountId === account.id;
                return (
                  <Pressable
                    key={account.id}
                    testID={`goal-account-${account.id}`}
                    onPress={() => setAccountId(account.id)}
                    style={[styles.accountRow, { borderColor: selected ? C.accent : C.hairline, backgroundColor: selected ? 'rgba(124,140,255,.10)' : C.card }]}
                  >
                    <Text style={[styles.accountName, { color: selected ? C.textBright : C.textMid }]} numberOfLines={1}>
                      {selected ? '✓ ' : ''}{account.name}
                    </Text>
                    {account.amount != null && <Text style={styles.accountBalance}>{fmt(account.amount)}</Text>}
                  </Pressable>
                );
              })}
            </View>
          )
        )}

        {source === 'manual' && (
          <>
            <AmountField label="STARTING BALANCE" placeholder="e.g. 2500" value={manualBalance} onChangeText={setManualBalance} />
            <Text style={styles.label}>AS OF</Text>
            <NativeDateField value={manualAsOf} onChange={(iso) => setManualAsOf(iso ?? todayISO)} maximumDate={today} />
          </>
        )}

        <AmountField
          label="TARGET AMOUNT"
          placeholder={grow ? 'e.g. 10000' : 'e.g. 0'}
          value={targetAmount}
          onChangeText={setTargetAmount}
          hint={grow ? 'What you want to save up to.' : 'What you want the balance to fall to — $0 clears it.'}
        />

        <Text style={styles.label}>TARGET DATE</Text>
        <NativeDateField value={targetDate} onChange={setTargetDate} minimumDate={tomorrowOf(today)} placeholder="Pick a date" />

        <AmountField
          label={grow ? 'COUNT FROM (OPTIONAL)' : 'STARTING AMOUNT OWED (OPTIONAL)'}
          placeholder="e.g. 500"
          value={baseline}
          onChangeText={setBaseline}
          hint={grow
            ? 'Money already in the account that isn’t for this goal — progress counts from here.'
            : 'What you owe today — the progress bar measures down from this.'}
        />

        {editing && (
          <Pressable testID="goal-delete" onPress={onDelete} style={styles.deleteBtn}>
            <Text style={styles.deleteText}>Delete goal</Text>
          </Pressable>
        )}

        <Pressable testID="goal-save" onPress={onSave} disabled={saving || editingUnloaded} style={[styles.save, (saving || editingUnloaded) && { opacity: 0.6 }]}>
          <Text style={styles.saveText}>{saving ? 'Saving…' : 'Save goal'}</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

// The balance source a saved goal uses: a synced account (account_id present) or a manual
// snapshot. null when creating (no goal yet) — the form forces a choice.
function sourceOf(goal: { account_id?: string | null } | undefined): Source | null {
  if (!goal) return null;
  return goal.account_id ? 'synced' : 'manual';
}

function tomorrowOf(today: Date): Date {
  const d = new Date(today);
  d.setDate(d.getDate() + 1);
  return d;
}

function Segment({ label, selected, onPress, testID }: { label: string; selected: boolean; onPress: () => void; testID: string }) {
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      style={[styles.segment, { borderColor: selected ? C.accent : 'rgba(255,255,255,.07)', backgroundColor: selected ? 'rgba(124,140,255,.14)' : C.card }]}
    >
      <Text style={[styles.segmentText, { color: selected ? C.accentSofter : C.textMid }]} numberOfLines={1}>{label}</Text>
    </Pressable>
  );
}

function AmountField({ label, placeholder, value, onChangeText, hint }: {
  label: string; placeholder: string; value: string; onChangeText: (t: string) => void; hint?: string;
}) {
  return (
    <View>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.inputRow}>
        <Text style={styles.affix}>$</Text>
        <TextInput
          style={styles.rowInput}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={C.placeholder}
          keyboardType="decimal-pad"
          inputMode="decimal"
        />
      </View>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  label: { fontFamily: FONT.body, fontSize: 12, fontWeight: '700', color: C.textMid, letterSpacing: 0.3, marginTop: 18, marginBottom: 8, marginHorizontal: 2 },
  input: { fontFamily: FONT.body, fontSize: 16, color: C.text, backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 14, paddingHorizontal: 14, height: 50 },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 14, paddingHorizontal: 14, height: 50 },
  rowInput: { flex: 1, fontFamily: FONT.body, fontSize: 16, color: C.text, height: '100%', textAlignVertical: 'center' },
  affix: { fontFamily: FONT.body, fontSize: 16, fontWeight: '600', color: C.textDim },
  hint: { fontFamily: FONT.body, fontSize: 11.5, color: C.textFaint, marginTop: 5 },

  iconGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  iconBtn: { width: 46, height: 46, borderRadius: 13, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },

  segmentRow: { flexDirection: 'row', gap: 8 },
  segment: { flex: 1, alignItems: 'center', paddingVertical: 13, borderRadius: 13, borderWidth: 1 },
  segmentText: { fontFamily: FONT.body, fontSize: 14, fontWeight: '600' },

  accountList: { marginTop: 8, gap: 8 },
  accountRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingVertical: 13, paddingHorizontal: 14, borderRadius: 13, borderWidth: 1 },
  accountName: { flex: 1, fontFamily: FONT.body, fontSize: 14, fontWeight: '600' },
  accountBalance: { fontFamily: FONT.body, fontSize: 13.5, fontWeight: '700', color: C.textDim },

  deleteBtn: { marginTop: 24, paddingVertical: 15, borderRadius: 15, borderWidth: 1, borderColor: 'rgba(255,107,107,.3)', backgroundColor: 'rgba(255,107,107,.08)', alignItems: 'center' },
  deleteText: { fontFamily: FONT.body, fontSize: 15, fontWeight: '600', color: C.bad },
  save: { marginTop: 12, paddingVertical: 16, borderRadius: 15, backgroundColor: C.accent, alignItems: 'center' },
  saveText: { fontFamily: FONT.body, fontSize: 16, fontWeight: '700', color: C.accentInk },
});
