import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Modal, ScrollView, TextInput, Animated } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, FONT, tint, fmt2 } from '../theme';
import { Icon, Glyph } from '../icons';
import { useAppContext, merchantLabel, categoryTreeRows } from '../context';
import { useTransactionsScreenData, useCategories, useRulesScreenData, usePayCycle, useGoalsQuery, useIsAuthed } from '../queries';
import { useReduceMotion } from '../motion/useReduceMotion';
import { springSheetIn, SHEET_ENTER_OFFSET } from '../motion/sheetMotion';
// The last_pay_date is an ISO "YYYY-MM-DD" string; these parse/format it via LOCAL
// date components (not UTC) so the calendar and label show the day the user picked —
// no midnight-timezone drift. Shared with the loan form's goal-date picker (WHIT-126).
import { parseISODate, toISODate, formatDayMonthYear } from '../dateutil';
import { useNativeDate } from './NativeDateField';
import { parseAmount, numText } from '../numutil';
import { QuickCreateCategory, CategoryDraft } from './QuickCreateCategory';
import { useSheetDraft } from '../hooks/useSheetDraft';

export function Overlays() {
  // WHIT-268: unmount the whole overlay layer while not authed. This is the privacy
  // shield — a toast/sheet over the login screen ('anon') OR the Face ID lock screen
  // ('locked') is the leak this card closes, and unmounting is the only reliable hide
  // because SheetHost is a native Modal that portals ABOVE any parent styling. The
  // context-held `sheet`/`toast`/`notif` values survive (AppProvider only clears them
  // on 'anon'), so a toast reappears after unlock — but a sheet's LOCAL form state
  // (half-typed rule/goal text) is lost on a lock, since unmounting destroys it.
  // Preserving in-progress input across a lock needs the app kept mounted under an
  // opaque cover — that's WHIT-266's mechanism, deliberately not built here.
  const isAuthed = useIsAuthed();
  if (!isAuthed) return null;
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
            <Glyph name="check" size={16} color={C.heroInk} />
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
      {/* WHIT-288: the tap-to-close backdrop sits BEHIND the sheet (a sibling absoluteFill
          Pressable), not WRAPPED around it. The old structure wrapped the sheet — and its
          ScrollView — in a Pressable (to swallow taps so they didn't close the sheet); that
          Pressable competed with the ScrollView for the touch, so the picker scrolled only
          intermittently depending on where the finger landed. As a sibling underneath, the
          backdrop still catches taps OUTSIDE the sheet (close), while the sheet is a plain View
          whose ScrollView now owns the gesture and scrolls reliably. `box-none` on the lift lets
          taps in the empty margins beside a narrow sheet fall through to the backdrop. */}
      <View style={styles.scrim}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={() => s.setSheet(null)}
          accessibilityRole="button"
          accessibilityLabel="Close"
        />
        <Animated.View style={[styles.sheetLift, { transform: [{ translateY }] }]} pointerEvents="box-none">
          <View style={styles.sheet}>
            <View style={styles.grabber} />
            {s.sheet?.mode === 'picker' && <PickerSheet />}
            {s.sheet?.mode === 'confirm' && <ConfirmSheet />}
            {s.sheet?.mode === 'addrule' && <AddRuleSheet key={s.sheet.ruleId ?? 'new'} />}
            {s.sheet?.mode === 'paycycle' && <PayCycleSheet />}
            {s.sheet?.mode === 'goalbalance' && <GoalBalanceSheet key={s.sheet.goalId} />}
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

function PickerSheet() {
  const s = useAppContext(); // sheet + chooseCategory + createCategoryInline (client-state)
  // WHIT-203: the transaction + category list come from the cached query layer (warm
  // from the always-mounted tab bar), not the old store.
  const { transactions } = useTransactionsScreenData();
  const { categories: cats } = useCategories();
  // WHIT-283: per-transaction draft keys, derived before the hooks so they're stable. The inline
  // new-category form + its "form is open" flag survive a Face ID lock (Overlays unmounts the whole
  // layer while locked) and restore on unlock — scoped by txId so two transactions' drafts can't
  // cross. SheetHost only mounts PickerSheet for mode 'picker', so txId is non-null in practice.
  const { readSheetDraft, writeSheetDraft } = s;
  const sh = s.sheet;
  const txId = sh?.mode === 'picker' ? sh.txId : null;
  const creatingKey = `pickercreating:${txId}`;
  const catDraftKey = `pickercat:${txId}`;
  // WHIT-238: create a category inline instead of leaving for Settings. `creating` swaps the
  // list for the mini-form; `submitting` guards a double-tap while the create is in flight.
  // WHIT-283: `creating` restores from the draft so unlock reopens INTO the form, not the list.
  const [creating, setCreating] = useSheetDraft<boolean>(creatingKey, (draft) => draft === true);
  const [submitting, setSubmitting] = useState(false);
  // WHIT-273: which parents are folded away. Empty = everything expanded, so the picker opens
  // fully revealed (you're here to find a category fast). A `collapsed` Set (vs Insights'
  // `expanded`) gives that expanded-by-default without pre-seeding every parent id.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = useCallback((id: string) => setCollapsed((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  }), []);
  // WHIT-283: hand the shared QuickCreateCategory stable read/write callbacks for its own fields.
  // All ref writes → zero re-render. Cleared on close/sign-out by the provider (WHIT-277), so this
  // only ever preserves across a lock. (`creating` persists via useSheetDraft above.)
  const readCatDraft = useCallback(() => readSheetDraft(catDraftKey) as Partial<CategoryDraft> | undefined, [readSheetDraft, catDraftKey]);
  const writeCatDraft = useCallback((d: CategoryDraft) => writeSheetDraft(catDraftKey, d), [writeSheetDraft, catDraftKey]);
  if (sh?.mode !== 'picker') return null;
  const tx = transactions.find((t) => t.transaction_id === sh.txId);
  if (!tx) return null;
  // WHIT-273: render as a parent→child tree (siblings A–Z within each group, so a newly-created
  // category isn't stranded — WHIT-158). A row shows only when its whole parent chain is expanded;
  // rows arrive depth-first (parent before child) so this single pass is enough.
  const treeRows = categoryTreeRows(cats);
  const visibleIds = new Set<string>();
  for (const row of treeRows) {
    if (row.parentId === null || (visibleIds.has(row.parentId) && !collapsed.has(row.parentId))) {
      visibleIds.add(row.category.id);
    }
  }
  const visibleRows = treeRows.filter((row) => visibleIds.has(row.category.id));

  // Create the category, then file THIS transaction into it. `chooseCategory` advances the
  // sheet (still mode 'picker') to the confirm step, which reads the new category from the
  // ['categories'] cache the inline create just mirrored into. A null result already toasted.
  const createAndFile = async (draft: CategoryDraft) => {
    setSubmitting(true);
    try {
      const created = await s.createCategoryInline(draft);
      if (created) s.chooseCategory(created.id);
      else setSubmitting(false);
    } catch (error) {
      setSubmitting(false); // WHIT-249: re-enable on an unexpected throw; re-throw so the guard logs it
      throw error;
    }
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
            // WHIT-283: Cancel discards the draft, so cancel→reopen is a fresh empty form (exactly
            // like today); a Face ID lock is the only thing that preserves it.
            onCancel={() => { setCreating(false); writeSheetDraft(catDraftKey, undefined); }}
            readDraft={readCatDraft}
            writeDraft={writeCatDraft}
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
        {visibleRows.map(({ category: c, depth, hasChildren }) => {
          const isCollapsed = collapsed.has(c.id);
          return (
            // Two sibling tap targets, never nested: the name (chip + label) selects the
            // category; the chevron folds its subs. Keeping them separate means a fold tap
            // can't also file the transaction. The chevron shows only on parents (a childless
            // row has nothing to fold), so a chevron always means "tap to expand/collapse".
            <View
              key={c.id}
              style={[styles.pickRow, depth > 0 && { marginLeft: depth * 18, borderLeftWidth: 2, borderLeftColor: c.color, paddingLeft: 11 }]}
            >
              <Pressable onPress={() => s.chooseCategory(c.id)} style={styles.pickNameHit}>
                <View style={[styles.pickChip, { backgroundColor: tint(c.color, 0.15) }]}>
                  <Icon name={c.icon} size={19} color={c.color} />
                </View>
                <Text testID="pickerCatName" style={styles.pickName}>{c.name}</Text>
              </Pressable>
              {hasChildren && (
                <Pressable
                  testID={`pickerCatToggle-${c.id}`}
                  onPress={() => toggle(c.id)}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: !isCollapsed }}
                  style={styles.pickToggle}
                >
                  <Glyph name={isCollapsed ? 'chevron' : 'chevronDown'} size={16} color={C.textFaint} />
                </Pressable>
              )}
            </View>
          );
        })}
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
  // WHIT-287: a re-categorise opened from the detail screen (refileOnly) is about THIS one
  // charge — offer a single re-file, no merchant-wide rule. applyCategory('one') already
  // handles any origin (already-categorised, income, non-budget) and rolls back on failure.
  // The list flow (refileOnly absent) keeps both the rule sweep and the single-file option.
  const refileOnly = sh.refileOnly;
  return (
    <View>
      <View style={[styles.confirmChip, { backgroundColor: tint(c.color, 0.16) }]}>
        <Icon name={c.icon} size={26} color={c.color} />
      </View>
      <Text style={styles.confirmTitle}>File as {c.name}</Text>
      {refileOnly ? (
        <>
          <Text style={styles.confirmSub}>Re-file '{merchantLabel(tx)}' under {c.name}.</Text>
          <Pressable onPress={() => s.applyCategory('one')} style={[styles.btn, styles.btnPrimary]}>
            <Text style={styles.btnPrimaryText}>Save</Text>
          </Pressable>
        </>
      ) : (
        <>
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
        </>
      )}
    </View>
  );
}

function AddRuleSheet() {
  const s = useAppContext(); // sheet + updateRule + saveManualRule (writers)
  const { rules } = useRulesScreenData();
  const { categories: cats, isLoading: catsLoading, isError: catsError, category } = useCategories();
  const sh = s.sheet;
  // ruleId present -> editing an existing rule; prefill from it. The sheet is
  // keyed on ruleId (see SheetHost), so it remounts per rule and these
  // initialisers re-run.
  const editing = sh?.mode === 'addrule' && sh.ruleId ? rules.find((r) => r.id === sh.ruleId) : undefined;
  // WHIT-277: survive a Face ID lock — restore any draft stashed before the lock (keyed on the
  // rule, matching SheetHost's remount key), else fall back to today's prefill. Lazy init runs
  // once on (re)mount, so the unlock remount reads back the stashed text.
  const draftKey = `addrule:${(sh?.mode === 'addrule' ? sh.ruleId : undefined) ?? 'new'}`;
  // WHIT-285: persist + restore both fields under one key via the shared hook. The two fields
  // share one object state so a single draft round-trips; the alias setters keep the JSX below
  // byte-identical and bail on an unchanged value, so re-selecting the same category writes nothing.
  // The aliases take a plain value (not a functional updater) — every call site passes one.
  const [draft, setDraft] = useSheetDraft<{ pattern: string; categoryId: string | null }>(
    draftKey,
    (stored) => ({
      pattern: stored?.pattern ?? editing?.pattern ?? '',
      categoryId: stored?.categoryId ?? editing?.categoryId ?? null,
    }),
  );
  const { pattern, categoryId } = draft;
  const setPattern = (value: string) => setDraft((prev) => {
    if (prev.pattern === value) return prev;
    return { ...prev, pattern: value };
  });
  const setCategoryId = (value: string | null) => setDraft((prev) => {
    if (prev.categoryId === value) return prev;
    return { ...prev, categoryId: value };
  });
  // WHIT-284: once the category list has LOADED, drop a restored/prefilled categoryId that no longer
  // exists (its category was deleted — e.g. on another device while locked). This clears the (invisible)
  // dead pill and lets the persist effect re-clean the draft so the dead id can't be re-restored on the
  // next lock. Gate on `!catsLoading`, NOT cats.length: an EMPTY list is ambiguous (still loading vs the
  // LAST category was just deleted), and a length gate would miss the last-category case — leaving the
  // dead id live, the exact bug this fixes. Also gate on `!catsError`: a cold-load ERROR (no cache) also
  // reports isLoading=false with an empty list, and dropping there would WRONGLY clear a valid id (and
  // stickily wipe it from the draft) — so only drop on a genuine loaded-OK list, never on a failed one.
  // Depends on `cats` (not the memoised `category` selector) so it re-fires whenever the list swaps —
  // an in-session delete must re-run the drop. setCategoryId(null) routes through the hook's persist
  // effect (WHIT-285), so the dead id is scrubbed from the stored draft too.
  useEffect(() => {
    if (!catsLoading && !catsError && categoryId && !cats.some((c) => c.id === categoryId)) setCategoryId(null);
  }, [catsLoading, catsError, cats, categoryId]);
  // Alphabetical so a newly-created category isn't stranded at the bottom (WHIT-158).
  const categories = [...cats].sort((a, b) => a.name.localeCompare(b.name));
  // WHIT-284: save is enabled only when the picked id resolves to a REAL category. This alone forbids
  // submitting a dead id — including in the loading window before the drop effect runs (while loading
  // the selector can't resolve any id, so save stays disabled until the list arrives; the effect above
  // still keeps a valid restored id selected so it re-enables the moment the list loads).
  const canSave = pattern.trim().length > 0 && !!category(categoryId);
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
  // iOS shows a COMPACT date pill inline; Android opens the modal dialog off a row.
  // The pick-vs-dismiss + arg-extraction quirk lives in the shared hook (WHIT-255).
  const { isIOS, showPicker, openPicker, commit } = useNativeDate((iso) => s.setPayday(iso));

  // A payday can be today or in the past, never the future — so does the picker.
  const today = new Date();

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
            onChange={commit}
          />
        </View>
      ) : (
        <Pressable
          onPress={openPicker}
          style={[styles.cycleRow, { marginTop: 10, backgroundColor: C.cardAlt, borderColor: 'rgba(255,255,255,.07)' }]}
        >
          <Text style={[styles.cycleText, { color: C.textMid }]}>{formatDayMonthYear(payCycle.last_pay_date)}</Text>
          <Glyph name="calendar" size={18} color={C.textDim} />
        </Pressable>
      )}
      {!isIOS && showPicker && (
        <DateTimePicker
          value={parseISODate(payCycle.last_pay_date)}
          mode="date"
          display="default"
          maximumDate={today}
          onChange={commit}
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
  // WHIT-277: restore any draft stashed before a Face ID lock (keyed on the goal, matching
  // SheetHost's remount key), else the live balance / today. Lazy init runs before the
  // `if (!goal) return null` below, so the draft survives even a momentary goal-undefined remount.
  const draftKey = `goalbalance:${goalId}`;
  // WHIT-285: persist + restore both fields under one key via the shared hook. The two fields
  // share one object state; the alias setters keep the JSX below byte-identical and bail on an
  // unchanged value (they take a plain value, not a functional updater). Default the as-of to
  // TODAY: an update means "here's the balance now"; the user can back-date it (max today) if
  // entering a figure from an earlier statement.
  const [draft, setDraft] = useSheetDraft<{ balance: string; asOf: string }>(
    draftKey,
    (stored) => ({
      balance: stored?.balance ?? numText(goal?.manual_balance),
      asOf: stored?.asOf ?? toISODate(today),
    }),
  );
  const { balance, asOf } = draft;
  const setBalance = (value: string) => setDraft((prev) => {
    if (prev.balance === value) return prev;
    return { ...prev, balance: value };
  });
  const setAsOf = (value: string) => setDraft((prev) => {
    if (prev.asOf === value) return prev;
    return { ...prev, asOf: value };
  });
  const { isIOS, showPicker, openPicker, commit } = useNativeDate((iso) => setAsOf(iso));
  const [saving, setSaving] = useState(false);

  // The goal can be gone (deleted elsewhere) or not yet cached — close cleanly rather than
  // crash, like PickerSheet/ConfirmSheet do for a missing transaction.
  if (!goal) return null;

  const onSave = async () => {
    // parseAmount rejects blanks / trailing garbage / negatives and is unsigned, so any value
    // it accepts is >= 0.
    const amount = parseAmount(balance);
    if (Number.isNaN(amount)) return s.showToast('Enter a balance of $0 or more.');
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
            onChange={commit}
          />
        </View>
      ) : (
        <Pressable
          testID="goal-asof-open"
          onPress={openPicker}
          style={[styles.cycleRow, { marginTop: 6, backgroundColor: C.cardAlt, borderColor: 'rgba(255,255,255,.07)' }]}
        >
          <Text style={[styles.cycleText, { color: C.textMid }]}>{formatDayMonthYear(asOf)}</Text>
          <Glyph name="calendar" size={18} color={C.textDim} />
        </Pressable>
      )}
      {!isIOS && showPicker && (
        <DateTimePicker
          value={parseISODate(asOf)}
          mode="date"
          display="default"
          maximumDate={today}
          onChange={commit}
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
  toastText: { fontFamily: FONT.body, color: C.textBright, fontSize: 13.5, textAlign: 'center' },
  // load-error banner (read failures). Sits just under a notif's z so the rare notif
  // wins if both are up at once.
  // notif
  notifWrap: { position: 'absolute', left: 12, right: 12, zIndex: 300 },
  notif: { backgroundColor: 'rgba(34,34,40,.94)', borderWidth: 1, borderColor: 'rgba(255,255,255,.1)', borderRadius: 20, padding: 14 },
  notifIcon: { flexDirection: 'row', gap: 11, alignItems: 'flex-start' },
  notifLogo: { width: 30, height: 30, borderRadius: 8, backgroundColor: C.good, alignItems: 'center', justifyContent: 'center' },
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
  sheetTitle: { fontFamily: FONT.display, fontSize: 20, fontWeight: '700', color: C.text, letterSpacing: -0.3 },
  sheetMerchant: { fontFamily: FONT.body, fontSize: 14, color: C.textMid, marginTop: 8 },
  sheetAmount: { fontFamily: FONT.display, fontSize: 22, fontWeight: '800', color: C.textBright, marginTop: 2, letterSpacing: -0.5 },
  pickRow: { flexDirection: 'row', alignItems: 'center', gap: 13, paddingVertical: 11 },
  pickNameHit: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 13 },
  pickToggle: { padding: 6 },
  pickChip: { width: 38, height: 38, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  pickName: { flex: 1, fontFamily: FONT.body, fontSize: 15, fontWeight: '600', color: C.textBright },
  confirmChip: { width: 52, height: 52, borderRadius: 15, alignSelf: 'center', alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  confirmTitle: { fontFamily: FONT.display, fontSize: 19, fontWeight: '700', color: C.text, textAlign: 'center' },
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
