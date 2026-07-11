import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Modal, ScrollView, TextInput, Platform, Animated } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, FONT, tint, fmt2 } from '../theme';
import { Icon, Glyph } from '../icons';
import { useAppContext, merchantLabel } from '../context';
import { useTransactionsScreenData, useCategories, useRulesScreenData, usePayCycle, useGoalsQuery, useIsAuthed } from '../queries';
import { useReduceMotion } from '../motion/useReduceMotion';
import { springSheetIn, SHEET_ENTER_OFFSET } from '../motion/sheetMotion';
// The last_pay_date is an ISO "YYYY-MM-DD" string; these parse/format it via LOCAL
// date components (not UTC) so the calendar and label show the day the user picked —
// no midnight-timezone drift. Shared with the loan form's goal-date picker (WHIT-126).
import { parseISODate, toISODate, formatDayMonthYear } from '../dateutil';
import { QuickCreateCategory, CategoryDraft } from './QuickCreateCategory';

export function Overlays() {
  return (
    <>
      <NotifBanner />
      <Toast />
      <SheetHost />
      {/* picker -> confirm reuse the same modal stack via store.sheet */}
    </>
  );
}

function Toast() {
  const { toast } = useAppContext();
  const insets = useSafeAreaInsets();
  if (!toast) return null;
  return (
    <View pointerEvents="none" style={[styles.toastWrap, { bottom: insets.bottom + 96 }]}>
      <View style={styles.toast}>
        <Text style={styles.toastText}>{toast}</Text>
      </View>
    </View>
  );
}

function NotifBanner() {
  const { notif, dismissNotif } = useAppContext();
  const insets = useSafeAreaInsets();
  if (!notif) return null;
  return (
    <View style={[styles.notifWrap, { top: insets.top + 8 }]}>
      <Pressable onPress={dismissNotif} style={styles.notif}>
        <View style={styles.notifIcon}>
          <View style={styles.notifLogo}>
            <Glyph name="check" size={16} color="#15123a" />
          </View>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 3 }}>
              <Text style={styles.notifApp}>WHITTLE</Text>
              <Text style={styles.notifTime}>{notif.time}</Text>
            </View>
            <Text style={styles.notifBody}>{notif.body}</Text>
          </View>
        </View>
      </Pressable>
    </View>
  );
}

function SheetHost() {
  const s = useAppContext();
  const open = !!s.sheet;
  const reduceMotion = useReduceMotion();
  // WHIT-199: a native-feeling spring on open. The sheet rises from SHEET_ENTER_OFFSET and
  // springs to rest; reduce-motion jumps instantly (springSheetIn). The CLOSE is the Modal's
  // fade (animationType) rather than the old vertical slide — a softer dissolve of the scrim +
  // card. (The inner sheets are gated on s.sheet?.mode, so their content unmounts the moment
  // s.sheet is null — as it always has; the fade dissolves the empty shell, it doesn't slide a
  // populated card down.) reduce-motion drops the fade too ('none') so nothing animates.
  // Read reduce-motion from a ref so the open effect always sees the fresh value WITHOUT it
  // being a trigger: the spring runs only when the sheet OPENS, never when the OS reduce-motion
  // setting is toggled while a sheet is already at rest (which would otherwise re-seed + re-spring
  // an open sheet under the user — WHIT-199 qa edge #2).
  const reduceMotionRef = useRef(reduceMotion);
  reduceMotionRef.current = reduceMotion;
  const translateY = useRef(new Animated.Value(SHEET_ENTER_OFFSET)).current;
  useEffect(() => {
    if (!open) return;
    const rm = reduceMotionRef.current;
    translateY.setValue(rm ? 0 : SHEET_ENTER_OFFSET); // seed below, then rise
    springSheetIn(translateY, rm);
  }, [open, translateY]);

  return (
    <Modal
      visible={open}
      transparent
      animationType={reduceMotion ? 'none' : 'fade'}
      onRequestClose={() => s.setSheet(null)}
    >
      <Pressable style={styles.scrim} onPress={() => s.setSheet(null)}>
        <Animated.View style={[styles.sheetLift, { transform: [{ translateY }] }]}>
          <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
            <View style={styles.grabber} />
            {s.sheet?.mode === 'picker' && <PickerSheet />}
            {s.sheet?.mode === 'confirm' && <ConfirmSheet />}
            {s.sheet?.mode === 'addrule' && <AddRuleSheet key={s.sheet.ruleId ?? 'new'} />}
            {s.sheet?.mode === 'paycycle' && <PayCycleSheet />}
            {s.sheet?.mode === 'goalbalance' && <GoalBalanceSheet key={s.sheet.goalId} />}
          </Pressable>
        </Animated.View>
      </Pressable>
    </Modal>
  );
}

function PickerSheet() {
  const s = useAppContext(); // sheet + chooseCategory + createCategoryInline (client-state)
  // WHIT-203: the transaction + category list come from the cached query layer (warm
  // from the always-mounted tab bar), not the old store.
  const { transactions } = useTransactionsScreenData();
  const { categories: cats } = useCategories();
  // WHIT-238: create a category inline instead of leaving for Settings. `creating` swaps the
  // list for the mini-form; `submitting` guards a double-tap while the create is in flight.
  const [creating, setCreating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const sh = s.sheet;
  if (sh?.mode !== 'picker') return null;
  const tx = transactions.find((t) => t.transaction_id === sh.txId);
  if (!tx) return null;
  // Alphabetical so a newly-created category isn't stranded at the bottom (WHIT-158).
  const categories = [...cats].sort((a, b) => a.name.localeCompare(b.name));

  // Create the category, then file THIS transaction into it. `chooseCategory` advances the
  // sheet (still mode 'picker') to the confirm step, which reads the new category from the
  // ['categories'] cache the inline create just mirrored into. A null result already toasted.
  const createAndFile = async (draft: CategoryDraft) => {
    setSubmitting(true);
    const created = await s.createCategoryInline(draft);
    if (created) s.chooseCategory(created.id);
    else setSubmitting(false);
  };

  if (creating) {
    return (
      <View>
        <Text style={styles.sheetTitle}>New category</Text>
        <Text style={styles.sheetMerchant}>File '{merchantLabel(tx)}' into a new category</Text>
        <View style={{ marginTop: 14 }}>
          <QuickCreateCategory
            initialBucket="Lifestyle"
            parentPicker
            categories={cats}
            submitLabel="Create & file"
            busy={submitting}
            onSubmit={createAndFile}
            onCancel={() => setCreating(false)}
          />
        </View>
      </View>
    );
  }

  return (
    <View>
      <Text style={styles.sheetTitle}>Categorize</Text>
      <Text style={styles.sheetMerchant}>{merchantLabel(tx)}</Text>
      {/* Sign-aware: an income transaction is positive, so a hardcoded "-$" would
          misread it as spend once income categories are pickable (WHIT-158). */}
      <Text style={styles.sheetAmount}>{fmt2(tx.amount)}</Text>
      <ScrollView style={{ maxHeight: 340, marginTop: 12 }}>
        {/* WHIT-238: make a category on the spot rather than round-tripping to Settings. */}
        <Pressable testID="pickerNewCategory" onPress={() => setCreating(true)} style={styles.pickRow}>
          <View style={[styles.pickChip, { backgroundColor: 'rgba(124,140,255,.14)' }]}>
            <Glyph name="plus" size={18} color={C.accent} />
          </View>
          <Text style={[styles.pickName, { color: C.accentSofter }]}>New category</Text>
        </Pressable>
        {categories.map((c) => (
          <Pressable key={c.id} onPress={() => s.chooseCategory(c.id)} style={styles.pickRow}>
            <View style={[styles.pickChip, { backgroundColor: tint(c.color, 0.15) }]}>
              <Icon name={c.icon} size={19} color={c.color} />
            </View>
            <Text testID="pickerCatName" style={styles.pickName}>{c.name}</Text>
            <Glyph name="chevron" size={16} color={C.textFaint} />
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

function ConfirmSheet() {
  const s = useAppContext(); // sheet + applyCategory (client-state / writer)
  const { transactions } = useTransactionsScreenData();
  const { category } = useCategories();
  const sh = s.sheet;
  if (sh?.mode !== 'confirm') return null;
  const tx = transactions.find((t) => t.transaction_id === sh.txId);
  const c = category(sh.categoryId);
  if (!tx || !c) return null;
  return (
    <View>
      <View style={[styles.confirmChip, { backgroundColor: tint(c.color, 0.16) }]}>
        <Icon name={c.icon} size={26} color={c.color} />
      </View>
      <Text style={styles.confirmTitle}>File as {c.name}</Text>
      <Text style={styles.confirmSub}>
        Apply to just '{merchantLabel(tx)}', or set a rule so every charge from this merchant files itself?
      </Text>
      <Pressable onPress={() => s.applyCategory('all')} style={[styles.btn, styles.btnPrimary]}>
        {/* Fixed label (not the interpolated merchant): the merchant is already named
            in the sub-text above, and a raw/long descriptor made this button ugly and
            wrap. Pairs with "Just this one" below. */}
        <Text style={styles.btnPrimaryText}>All from this merchant</Text>
      </Pressable>
      <Pressable onPress={() => s.applyCategory('one')} style={[styles.btn, styles.btnGhost]}>
        <Text style={styles.btnGhostText}>Just this one</Text>
      </Pressable>
    </View>
  );
}

function AddRuleSheet() {
  const s = useAppContext(); // sheet + updateRule + saveManualRule (writers)
  const { rules } = useRulesScreenData();
  const { categories: cats } = useCategories();
  const sh = s.sheet;
  // ruleId present -> editing an existing rule; prefill from it. The sheet is
  // keyed on ruleId (see SheetHost), so it remounts per rule and these
  // initialisers re-run.
  const editing = sh?.mode === 'addrule' && sh.ruleId ? rules.find((r) => r.id === sh.ruleId) : undefined;
  const [pattern, setPattern] = useState(editing?.pattern ?? '');
  const [categoryId, setCategoryId] = useState<string | null>(editing?.categoryId ?? null);
  // Alphabetical so a newly-created category isn't stranded at the bottom (WHIT-158).
  const categories = [...cats].sort((a, b) => a.name.localeCompare(b.name));
  const canSave = pattern.trim().length > 0 && !!categoryId;
  const submit = () => {
    if (!canSave) return;
    if (editing) s.updateRule(editing.id, pattern, categoryId!);
    else s.saveManualRule(pattern, categoryId!);
  };
  return (
    <View>
      <Text style={styles.sheetTitle}>{editing ? 'Edit rule' : 'New rule'}</Text>
      <Text style={styles.fieldLabel}>WHEN DESCRIPTION CONTAINS</Text>
      <TextInput
        value={pattern}
        onChangeText={setPattern}
        autoCapitalize="characters"
        placeholder="e.g. NETFLIX"
        placeholderTextColor={C.placeholder}
        style={styles.input}
      />
      <Text style={[styles.fieldLabel, { marginTop: 14 }]}>FILE IT AS</Text>
      <ScrollView style={{ maxHeight: 220, marginTop: 6 }}>
        <View style={styles.ruleCatWrap}>
          {categories.map((c) => {
            const sel = categoryId === c.id;
            return (
              <Pressable
                key={c.id}
                onPress={() => setCategoryId(c.id)}
                style={[styles.ruleCatPill, { backgroundColor: sel ? tint(c.color, 0.14) : C.cardAlt, borderColor: sel ? c.color : 'rgba(255,255,255,.06)' }]}
              >
                <Icon name={c.icon} size={12} color={c.color} />
                <Text style={[styles.ruleCatText, { color: sel ? '#fff' : C.textMid }]}>{c.name}</Text>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
      <Pressable
        onPress={submit}
        style={[styles.btn, { marginTop: 16, backgroundColor: canSave ? C.accent : 'rgba(124,140,255,.25)' }]}
      >
        <Text style={[styles.btnPrimaryText, { color: canSave ? C.accentInk : '#6a6a90' }]}>{editing ? 'Update rule' : 'Add rule'}</Text>
      </Pressable>
    </View>
  );
}

function PayCycleSheet() {
  const s = useAppContext(); // setPayCycleLength + setPayday + setSheet (writers/client-state)
  // WHIT-203: the current pay cycle is read from the query layer; the length/payday
  // writes double-write the ['payCycle'] cache (persistPayCycle), so a selection reflects
  // here immediately.
  const { payCycle } = usePayCycle();
  const opts = [{ n: 'Weekly', len: 7 }, { n: 'Fortnightly', len: 14 }, { n: 'Monthly', len: 30 }];
  const isIOS = Platform.OS === 'ios';
  // iOS shows a COMPACT date pill inline (tap -> calendar popover), so it needs no
  // toggle. Android has no compact display, so a row opens the modal dialog.
  const [showAndroidPicker, setShowAndroidPicker] = useState(false);

  // A payday can be today or in the past, never the future — so does the picker.
  const today = new Date();

  // The picker's callback is onChange, which fires as (event, date) — the Date is
  // the SECOND arg, not the first — so pull it out of whichever position it lands
  // in, rather than assume arg 0 is the Date (assuming arg 0 crashed once:
  // `event.getMonth()` is undefined). On a cancel/dismiss the date is undefined, so
  // nothing is committed.
  const commitDate = (a?: unknown, b?: unknown) => {
    const picked = a instanceof Date ? a : b instanceof Date ? b : undefined;
    if (picked) s.setPayday(toISODate(picked));
  };

  return (
    <View>
      <Text style={styles.sheetTitle}>Pay cycle</Text>
      <Text style={styles.confirmSub}>Budgets reset and pace is measured across this period.</Text>
      <View style={{ marginTop: 14, gap: 10 }}>
        {opts.map((o) => {
          const sel = payCycle.length === o.len;
          return (
            <Pressable
              key={o.len}
              onPress={() => s.setPayCycleLength(o.len)}
              style={[styles.cycleRow, { backgroundColor: sel ? 'rgba(124,140,255,.14)' : C.cardAlt, borderColor: sel ? C.accent : 'rgba(255,255,255,.07)' }]}
            >
              <Text style={[styles.cycleText, { color: sel ? C.accentSofter : C.textMid }]}>{o.n}</Text>
              {sel && <Glyph name="check" size={18} color={C.accent} />}
            </Pressable>
          );
        })}
      </View>

      <Text style={styles.cycleSectionLabel}>Last payday</Text>
      <Text style={styles.cycleSectionHint}>The budget window resets on this date — set it to your (or your partner's) actual last pay, including any public-holiday shift.</Text>
      {isIOS ? (
        <View style={[styles.cycleRow, { marginTop: 10, backgroundColor: C.cardAlt, borderColor: 'rgba(255,255,255,.07)' }]}>
          <Text style={[styles.cycleText, { color: C.textMid }]}>Set date</Text>
          <DateTimePicker
            value={parseISODate(payCycle.last_pay_date)}
            mode="date"
            display="compact"          // small native date pill, not the big inline grid
            maximumDate={today}
            themeVariant="dark"        // light text on the dark sheet
            accentColor={C.accent}     // selected day + popover accent match the palette
            onChange={commitDate}
          />
        </View>
      ) : (
        <Pressable
          onPress={() => setShowAndroidPicker(true)}
          style={[styles.cycleRow, { marginTop: 10, backgroundColor: C.cardAlt, borderColor: 'rgba(255,255,255,.07)' }]}
        >
          <Text style={[styles.cycleText, { color: C.textMid }]}>{formatDayMonthYear(payCycle.last_pay_date)}</Text>
          <Glyph name="calendar" size={18} color={C.textDim} />
        </Pressable>
      )}
      {!isIOS && showAndroidPicker && (
        <DateTimePicker
          value={parseISODate(payCycle.last_pay_date)}
          mode="date"
          display="default"
          maximumDate={today}
          // Android fires onChange for both pick and dismiss; close the dialog
          // either way, and commitDate only saves when a Date came through.
          onChange={(event, date) => { setShowAndroidPicker(false); commitDate(event, date); }}
        />
      )}

      <Pressable onPress={() => s.setSheet(null)} style={[styles.btn, styles.btnPrimary, { marginTop: 16 }]}>
        <Text style={styles.btnPrimaryText}>Done</Text>
      </Pressable>
    </View>
  );
}

// WHIT-235: update a MANUAL goal's balance in place — a quick amount + as-of edit opened from
// the goal card. Saving resends the WHOLE manual goal record via saveGoal (a whole-record PUT
// upsert), so every other field rides along unchanged. Synced goals never open this.
function GoalBalanceSheet() {
  const s = useAppContext(); // sheet + saveGoal + showToast
  const sh = s.sheet;
  const goalId = sh?.mode === 'goalbalance' ? sh.goalId : null;
  // Read the live record from the ['goals'] cache the hub already warms (mirrors the edit
  // form). Keyed on goalId in SheetHost, so these initialisers re-run per goal.
  const goal = useGoalsQuery(useIsAuthed()).data?.find((g) => g.id === goalId);
  const today = new Date();
  const isIOS = Platform.OS === 'ios';
  const [balance, setBalance] = useState(goal?.manual_balance != null ? String(goal.manual_balance) : '');
  // Default the as-of to TODAY: an update means "here's the balance now". The user can
  // back-date it (max today) if they're entering a figure from an earlier statement.
  const [asOf, setAsOf] = useState(toISODate(today));
  const [showAndroidPicker, setShowAndroidPicker] = useState(false);
  const [saving, setSaving] = useState(false);

  // The goal can be gone (deleted elsewhere) or not yet cached — close cleanly rather than
  // crash, like PickerSheet/ConfirmSheet do for a missing transaction.
  if (!goal) return null;

  const commitDate = (a?: unknown, b?: unknown) => {
    const picked = a instanceof Date ? a : b instanceof Date ? b : undefined;
    if (picked) setAsOf(toISODate(picked));
  };

  const onSave = async () => {
    // Strict decimal only — the regex has no sign, so blanks / trailing garbage / negatives
    // are all rejected, and any value that passes is >= 0.
    if (!/^\d*\.?\d+$/.test(balance.trim())) return s.showToast('Enter a balance of $0 or more.');
    const amount = parseFloat(balance.trim());
    setSaving(true);
    const ok = await s.saveGoal(goal.id, {
      name: goal.name, icon: goal.icon, direction: goal.direction,
      target_amount: goal.target_amount, target_date: goal.target_date,
      baseline: goal.baseline ?? null,
      manual_balance: amount, manual_as_of: asOf,
    });
    setSaving(false);
    if (ok) s.setSheet(null);
  };

  return (
    <View>
      <Text style={styles.sheetTitle}>Update balance</Text>
      <Text style={styles.confirmSub}>{goal.name} — set the current balance and the date it was true.</Text>

      <Text style={[styles.fieldLabel, { marginTop: 14 }]}>CURRENT BALANCE ($)</Text>
      <TextInput
        testID="goal-balance-input"
        value={balance}
        onChangeText={setBalance}
        placeholder="e.g. 2500"
        placeholderTextColor={C.placeholder}
        keyboardType="decimal-pad"
        inputMode="decimal"
        style={styles.input}
      />

      <Text style={[styles.fieldLabel, { marginTop: 14 }]}>AS OF</Text>
      {isIOS ? (
        <View style={[styles.cycleRow, { marginTop: 6, backgroundColor: C.cardAlt, borderColor: 'rgba(255,255,255,.07)' }]}>
          <Text style={[styles.cycleText, { color: C.textMid }]}>{formatDayMonthYear(asOf)}</Text>
          <DateTimePicker
            value={parseISODate(asOf)}
            mode="date"
            display="compact"
            maximumDate={today}
            themeVariant="dark"
            accentColor={C.accent}
            onChange={commitDate}
          />
        </View>
      ) : (
        <Pressable
          testID="goal-asof-open"
          onPress={() => setShowAndroidPicker(true)}
          style={[styles.cycleRow, { marginTop: 6, backgroundColor: C.cardAlt, borderColor: 'rgba(255,255,255,.07)' }]}
        >
          <Text style={[styles.cycleText, { color: C.textMid }]}>{formatDayMonthYear(asOf)}</Text>
          <Glyph name="calendar" size={18} color={C.textDim} />
        </Pressable>
      )}
      {!isIOS && showAndroidPicker && (
        <DateTimePicker
          value={parseISODate(asOf)}
          mode="date"
          display="default"
          maximumDate={today}
          onChange={(event, date) => { setShowAndroidPicker(false); commitDate(event, date); }}
        />
      )}

      <Pressable testID="goal-balance-save" onPress={onSave} disabled={saving} style={[styles.btn, styles.btnPrimary, { marginTop: 16 }, saving && { opacity: 0.6 }]}>
        <Text style={styles.btnPrimaryText}>{saving ? 'Saving…' : 'Save balance'}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  // toast
  toastWrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center', zIndex: 200 },
  toast: { maxWidth: '88%', backgroundColor: '#26262f', borderWidth: 1, borderColor: 'rgba(255,255,255,.1)', paddingVertical: 11, paddingHorizontal: 16, borderRadius: 14 },
  toastText: { fontFamily: FONT.body, color: '#f1f1f4', fontSize: 13.5, textAlign: 'center' },
  // load-error banner (read failures). Sits just under a notif's z so the rare notif
  // wins if both are up at once.
  // notif
  notifWrap: { position: 'absolute', left: 12, right: 12, zIndex: 300 },
  notif: { backgroundColor: 'rgba(34,34,40,.94)', borderWidth: 1, borderColor: 'rgba(255,255,255,.1)', borderRadius: 20, padding: 14 },
  notifIcon: { flexDirection: 'row', gap: 11, alignItems: 'flex-start' },
  notifLogo: { width: 30, height: 30, borderRadius: 8, backgroundColor: '#35d9a0', alignItems: 'center', justifyContent: 'center' },
  notifApp: { fontFamily: FONT.body, fontSize: 11, fontWeight: '700', color: '#cfd2ff', letterSpacing: 0.4 },
  notifTime: { fontFamily: FONT.body, fontSize: 11, color: C.textDim },
  notifBody: { fontFamily: FONT.body, fontSize: 13.5, color: '#e6e6ea', lineHeight: 19 },
  // sheet
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,.55)', justifyContent: 'flex-end', alignItems: 'center' },
  // Wraps the sheet so the spring transform (translateY) doesn't disturb its bottom-anchored,
  // horizontally-centred layout (WHIT-199).
  sheetLift: { width: '100%', alignItems: 'center' },
  sheet: { width: '100%', maxWidth: 440, backgroundColor: '#161620', borderTopLeftRadius: 26, borderTopRightRadius: 26, padding: 20, paddingBottom: 34, borderTopWidth: 1, borderColor: 'rgba(255,255,255,.08)' },
  grabber: { alignSelf: 'center', width: 38, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,.18)', marginBottom: 14 },
  sheetTitle: { fontFamily: FONT.display, fontSize: 20, fontWeight: '700', color: '#f4f4f6', letterSpacing: -0.3 },
  sheetMerchant: { fontFamily: FONT.body, fontSize: 14, color: C.textMid, marginTop: 8 },
  sheetAmount: { fontFamily: FONT.display, fontSize: 22, fontWeight: '800', color: '#f1f1f4', marginTop: 2, letterSpacing: -0.5 },
  pickRow: { flexDirection: 'row', alignItems: 'center', gap: 13, paddingVertical: 11 },
  pickChip: { width: 38, height: 38, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  pickName: { flex: 1, fontFamily: FONT.body, fontSize: 15, fontWeight: '600', color: '#f1f1f4' },
  confirmChip: { width: 52, height: 52, borderRadius: 15, alignSelf: 'center', alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  confirmTitle: { fontFamily: FONT.display, fontSize: 19, fontWeight: '700', color: '#f4f4f6', textAlign: 'center' },
  confirmSub: { fontFamily: FONT.body, fontSize: 13.5, color: C.textDim, textAlign: 'center', lineHeight: 20, marginTop: 8 },
  btn: { paddingVertical: 15, borderRadius: 15, alignItems: 'center', marginTop: 10 },
  btnPrimary: { backgroundColor: C.accent },
  btnPrimaryText: { fontFamily: FONT.body, fontSize: 15, fontWeight: '700', color: C.accentInk },
  btnGhost: { backgroundColor: 'transparent', borderWidth: 1, borderColor: 'rgba(255,255,255,.1)' },
  btnGhostText: { fontFamily: FONT.body, fontSize: 15, fontWeight: '600', color: '#e2e2e8' },
  fieldLabel: { fontFamily: FONT.body, fontSize: 12, fontWeight: '700', color: C.textMid, letterSpacing: 0.3, marginTop: 16, marginBottom: 7 },
  input: { backgroundColor: C.card, borderWidth: 1, borderColor: 'rgba(255,255,255,.08)', borderRadius: 14, paddingVertical: 14, paddingHorizontal: 16, color: '#fff', fontFamily: FONT.body, fontSize: 15 },
  ruleCatWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  ruleCatPill: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 11, borderWidth: 1 },
  ruleCatText: { fontFamily: FONT.body, fontSize: 13, fontWeight: '600' },
  cycleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 15, paddingHorizontal: 16, borderRadius: 14, borderWidth: 1 },
  cycleText: { fontFamily: FONT.body, fontSize: 15, fontWeight: '600' },
  cycleSectionLabel: { fontFamily: FONT.body, fontSize: 13, fontWeight: '700', color: C.textMid, marginTop: 20, letterSpacing: 0.2 },
  cycleSectionHint: { fontFamily: FONT.body, fontSize: 12.5, color: C.textDim, lineHeight: 18, marginTop: 4 },
});
