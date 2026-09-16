import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Modal, ScrollView, TextInput, Animated, GestureResponderEvent, KeyboardAvoidingView, Platform, ActivityIndicator } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, FONT, tint, fmt2 } from '../theme';
import { Icon, Glyph } from '../icons';
import { useAppContext, merchantLabel, categoryTreeRows, ruleConflict, ruleOverlap, categoryLabel, accountSummaries, APPLY_RULES_MAX_WRITES } from '../context';
import type { RuleConflict, ApplyRulesResult, ApplyRulesJob, Category, FileByShopOutcome, RuleWrite } from '../context';
import type { UncategorizedMerchantGroup, RuleCondition, RuleLogic } from '../api';
import { RULE_FIELD_OPERATORS, RULE_DIRECTIONS, ruleValueIsSafe } from '../ruleVocabulary';
import { useInFlightGuard } from '../hooks/useInFlightGuard';
import { useTransactionResolver, useCategories, useRulesScreenData, useRecentTransactionsScreenData, usePayCycle, useGoalsQuery, useIsAuthed, useUncategorizedMerchants } from '../queries';
import { useReduceMotion } from '../motion/useReduceMotion';
import { springSheetIn, SHEET_ENTER_OFFSET, shouldDismissSheet } from '../motion/sheetMotion';
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
  // context-held `sheet`/`toast` values survive (AppProvider only clears them
  // on 'anon'), so a toast reappears after unlock — but a sheet's LOCAL form state
  // (half-typed rule/goal text) is lost on a lock, since unmounting destroys it.
  // Preserving in-progress input across a lock needs the app kept mounted under an
  // opaque cover — that's WHIT-266's mechanism, deliberately not built here.
  const isAuthed = useIsAuthed();
  if (!isAuthed) return null;
  return (
    <>
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

function SheetHost() {
  const s = useAppContext();
  const open = !!s.sheet;
  // The category picker is the one sheet whose inline "New category" form can grow taller than the
  // space left above the keyboard (its name field auto-focuses, so the keyboard is up on open). Only
  // that sheet opts into the shrink chain below (sheetLift → sheet → the form's own ScrollView), so a
  // too-tall form scrolls within the visible area instead of being pushed off the top. Every other
  // sheet is short and keeps its exact layout — the flag scopes the change to where it's needed.
  const isPickerMode = s.sheet?.mode === 'picker' || s.sheet?.mode === 'pickerMany';
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

  // WHIT-290/WHIT-293: drag the grabber DOWN to dismiss. The handle sits above the ScrollView and
  // claims its own touches (onStartShouldSetResponder), so it never competes with list scrolling or
  // the backdrop. We track the finger delta from grant via pageY (no gesture library) and move the
  // sheet with the finger (down only). On release we dismiss on EITHER a far-enough pull OR a quick
  // downward flick — the flick makes it forgiving, so a short fast pull works instead of springing
  // back. Velocity is the last move segment's speed (Δpx/Δms from event timestamps); dt≤0 or a
  // missing timestamp falls back to 0 so the distance path still decides. Stable refs → the handler
  // object is created once with no stale capture.
  const dragStartY = useRef(0);
  const lastY = useRef(0);
  const lastT = useRef(0);
  const lastVy = useRef(0);
  const closeRef = useRef<() => void>(() => {});
  closeRef.current = () => s.setSheet(null);
  const grabHandlers = useRef({
    onStartShouldSetResponder: () => true,
    onResponderGrant: (e: GestureResponderEvent) => {
      dragStartY.current = e.nativeEvent.pageY;
      lastY.current = e.nativeEvent.pageY;
      lastT.current = e.nativeEvent.timestamp;
      lastVy.current = 0;
    },
    onResponderMove: (e: GestureResponderEvent) => {
      const { pageY, timestamp } = e.nativeEvent;
      const dt = timestamp - lastT.current;
      lastVy.current = dt > 0 ? (pageY - lastY.current) / dt : 0; // instantaneous downward speed
      lastY.current = pageY;
      lastT.current = timestamp;
      translateY.setValue(Math.max(0, pageY - dragStartY.current)); // down only
    },
    onResponderRelease: (e: GestureResponderEvent) => {
      if (shouldDismissSheet(e.nativeEvent.pageY - dragStartY.current, lastVy.current)) closeRef.current();
      else springSheetIn(translateY, reduceMotionRef.current); // snap back to rest
    },
    onResponderTerminate: () => springSheetIn(translateY, reduceMotionRef.current),
  }).current;

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
      {/* WHIT-294: a KeyboardAvoidingView lifts the bottom-anchored sheet above the keyboard so a
          focused field's form — including its submit button — stays visible instead of being hidden
          under the keyboard (you no longer have to dismiss the keyboard to reach the button). Shared
          here, so every input sheet (New category, New rule, Update balance) benefits. `padding`
          insets the bottom by the keyboard height on iOS (which flex-end then lifts the sheet into);
          Android uses `height`. Keyboard-less sheets get 0 inset, so nothing changes for them. */}
      <KeyboardAvoidingView style={styles.scrim} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={() => s.setSheet(null)}
          accessibilityRole="button"
          accessibilityLabel="Close"
        />
        <Animated.View style={[styles.sheetLift, isPickerMode && styles.sheetShrink, { transform: [{ translateY }] }]} pointerEvents="box-none">
          <View style={[styles.sheet, isPickerMode && styles.sheetShrink]}>
            <View testID="sheet-grabber" style={styles.grabHandle} {...grabHandlers}>
              <View style={styles.grabber} />
            </View>
            {s.sheet?.mode === 'picker' && <PickerSheet />}
            {s.sheet?.mode === 'pickerMany' && <PickerSheet />}
            {s.sheet?.mode === 'confirm' && <ConfirmSheet />}
            {s.sheet?.mode === 'confirmMany' && <ConfirmSheet />}
            {s.sheet?.mode === 'addrule' && <AddRuleSheet key={s.sheet.ruleId ?? 'new'} />}
            {s.sheet?.mode === 'paycycle' && <PayCycleSheet />}
            {s.sheet?.mode === 'goalbalance' && <GoalBalanceSheet key={s.sheet.goalId} />}
            {s.sheet?.mode === 'applyRules' && <ApplyRulesSheet />}
            {s.sheet?.mode === 'fileByShopList' && <FileByShopListSheet />}
            {s.sheet?.mode === 'fileByShopConfirm' && <FileByShopConfirmSheet key={`${s.sheet.group.rulePattern}:${s.sheet.categoryId}`} />}
            {s.sheet?.mode === 'addRuleConfirm' && <AddRuleConfirmSheet key={`${s.sheet.pattern}:${s.sheet.categoryId}`} />}
          </View>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function PickerSheet() {
  const s = useAppContext(); // sheet + chooseCategory + createCategoryInline (client-state)
  // WHIT-203: the transaction + category list come from the cached query layer (warm
  // from the always-mounted tab bar), not the old store. Resolve the tapped charge across every
  // list cache — feed, uncategorized feed, and the bounded recent window — via the shared
  // resolver, so a deep-history row tapped on the Uncategorized tab (present only in the
  // uncategorized cache) and a row tapped on account-detail both resolve.
  const { findTx } = useTransactionResolver();
  const { categories: cats } = useCategories();
  // WHIT-283: per-transaction draft keys, derived before the hooks so they're stable. The inline
  // new-category form + its "form is open" flag survive a Face ID lock (Overlays unmounts the whole
  // layer while locked) and restore on unlock — scoped by txId so two transactions' drafts can't
  // cross. SheetHost only mounts PickerSheet for mode 'picker', so txId is non-null in practice.
  const { readSheetDraft, writeSheetDraft } = s;
  const sh = s.sheet;
  // WHIT-291: the picker serves both a single charge ('picker') and a captured multi-select set
  // ('pickerMany'). Derive the target once; drafts scope per target ('many' for the set) so two
  // pickers can't cross their inline new-category forms.
  const isMany = sh?.mode === 'pickerMany';
  const txId = sh?.mode === 'picker' ? sh.txId : null;
  const manyIds = sh?.mode === 'pickerMany' ? sh.txIds : null;
  const draftScope = txId ?? 'many';
  const creatingKey = `pickercreating:${draftScope}`;
  const catDraftKey = `pickercat:${draftScope}`;
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
  if (sh?.mode !== 'picker' && sh?.mode !== 'pickerMany') return null;
  const tx = txId ? findTx(txId) : null;
  if (sh.mode === 'picker' && !tx) return null;
  // Header label: a single charge shows its merchant + amount; a multi-select shows the count.
  const count = manyIds?.length ?? 0;
  const headerLabel = isMany ? `${count} ${count === 1 ? 'transaction' : 'transactions'}` : merchantLabel(tx!);
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
      <View style={styles.createForm}>
        <Text style={styles.sheetTitle}>New category</Text>
        <Text style={styles.sheetMerchant}>{isMany ? `File ${headerLabel} into a new category` : `File '${merchantLabel(tx!)}' into a new category`}</Text>
        {/* The name field auto-focuses, so the keyboard is up the moment this form opens and the
            keyboard-avoider lifts the whole sheet. On a shorter screen the form is taller than the
            room above the keyboard, so its top — the title and the Category name field — was pushed
            off the screen with no way to pull it back. A bounded, shrinking ScrollView keeps the whole
            form reachable: the name field sits at the top of the scroll region (visible on open) and
            the buckets / icons / buttons scroll into view. `keyboardShouldPersistTaps` lets a chip or
            button tap land on the first press instead of being swallowed to dismiss the keyboard. */}
        <ScrollView
          style={styles.createScroll}
          contentContainerStyle={styles.createScrollContent}
          keyboardShouldPersistTaps="handled"
        >
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
        </ScrollView>
      </View>
    );
  }

  return (
    <View>
      <Text style={styles.sheetTitle}>Categorize</Text>
      <Text style={styles.sheetMerchant}>{headerLabel}</Text>
      {/* Sign-aware: an income transaction is positive, so a hardcoded "-$" would
          misread it as spend once income categories are pickable (WHIT-158). A multi-select
          has no single amount, so the amount line is omitted there (WHIT-291). */}
      {!isMany && <Text style={styles.sheetAmount}>{fmt2(tx!.amount)}</Text>}
      <ScrollView style={{ maxHeight: 340, marginTop: 12 }}>
        {/* WHIT-238: make a category on the spot rather than round-tripping to Settings. */}
        <Pressable testID="pickerNewCategory" onPress={() => setCreating(true)} style={styles.pickRow}>
          <View style={[styles.pickChip, { backgroundColor: tint(C.accentAlt, 0.14) }]}>
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
  const { findTx } = useTransactionResolver();
  const { category } = useCategories();
  const sh = s.sheet;

  // WHIT-291: multi-select confirm — re-file the whole captured set under one category in one
  // batch. No merchant rule (the ids are exactly what the user picked); a single "File N" action.
  if (sh?.mode === 'confirmMany') {
    const c = category(sh.categoryId);
    if (!c) return null;
    const { txIds, categoryId } = sh;
    const count = txIds.length;
    const noun = count === 1 ? 'transaction' : 'transactions';
    return (
      <View>
        <View style={[styles.confirmChip, { backgroundColor: tint(c.color, 0.16) }]}>
          <Icon name={c.icon} size={26} color={c.color} />
        </View>
        <Text style={styles.confirmTitle}>File as {c.name}</Text>
        <Text style={styles.confirmSub}>Re-file {count} {noun} under {c.name}.</Text>
        <Pressable onPress={() => s.applyCategoryToMany(txIds, categoryId)} style={[styles.btn, styles.btnPrimary]}>
          <Text style={styles.btnPrimaryText}>File {count} {noun}</Text>
        </Pressable>
      </View>
    );
  }

  if (sh?.mode !== 'confirm') return null;
  const tx = findTx(sh.txId);
  const c = category(sh.categoryId);
  if (!tx || !c) return null;
  // WHIT-324: one confirm for BOTH entry points — the Transactions list and the detail screen.
  // Always offer the merchant-wide rule ('all') alongside the single re-file ('one'), so a
  // re-categorise from the detail screen behaves exactly like one from the list (no more
  // redundant lone Save). applyCategory handles any origin (already-categorised, income,
  // non-budget) and rolls back on failure under either scope.
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

// WHIT-563 — the multi-condition rule builder. The fields the builder OFFERS: the server also
// supports `merchant` and `category` (kept for externally-authored rules), but the builder omits
// them — `merchant` duplicates `description`, and `category` clashes with the "file it as" target
// picker and matches a raw external taxonomy, not the app's categories.
const BUILDER_FIELDS = ['description', 'amount', 'account', 'direction'] as const;
type BuilderField = (typeof BUILDER_FIELDS)[number];
const FIELD_LABELS: Record<string, string> = {
  description: 'Description', amount: 'Amount', account: 'Account', direction: 'Type',
  merchant: 'Merchant', category: 'Category',
};
const OPERATOR_LABELS: Record<string, string> = {
  contains: 'contains', equals: 'is exactly',
  less_than: 'less than', less_than_or_equal: 'at most',
  greater_than: 'more than', greater_than_or_equal: 'at least',
};
const DIRECTION_LABELS: Record<string, string> = { debit: 'Spending', credit: 'Income' };

type DraftCondition = { field: string; operator: string; value: string };
type RuleDraft = { conditions: DraftCondition[]; logic: RuleLogic; categoryId: string | null; budgetExcluded: boolean };

// Only the classic single "description contains" rule keeps today's behaviour — the WHIT-538
// preview/confirm flow for new rules and the pattern-based conflict warning. Anything else saves
// via the conditions payload (WHIT-563).
function isClassicSingle(conditions: DraftCondition[]): boolean {
  return conditions.length === 1 && conditions[0].field === 'description' && conditions[0].operator === 'contains';
}

// A condition is saveable when its value fits the server's floor for that field (handler.py
// _validate_condition_value + the contains value floor): a `contains` text value must clear the
// alphanumeric floor; other text must be non-empty; an amount must be a positive number;
// account/direction must be chosen.
function conditionValid(condition: DraftCondition): boolean {
  const value = condition.value.trim();
  if (condition.field === 'amount') { const amount = parseAmount(value); return !isNaN(amount) && amount > 0; }
  if (condition.field === 'direction') return value === 'debit' || value === 'credit';
  if (condition.field === 'account') return value.length > 0;
  if (condition.operator === 'contains') return ruleValueIsSafe(value);
  return value.length > 0;
}

const ruleBuilderStyles = StyleSheet.create({
  conditionCard: { backgroundColor: C.cardAlt, borderRadius: 12, borderWidth: 1, borderColor: C.hairline, padding: 12, marginTop: 10 },
  pillWrap: { flexDirection: 'row', flexWrap: 'wrap' },
  pill: { paddingVertical: 7, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, marginRight: 8, marginBottom: 8 },
  pillText: { fontSize: 13, fontFamily: FONT.body },
  connector: { fontSize: 12, fontFamily: FONT.body, color: C.textDim, marginTop: 12, marginBottom: 2, letterSpacing: 1 },
  removeRow: { alignSelf: 'flex-end', marginTop: 4 },
  removeText: { color: C.textDim, fontSize: 12, fontFamily: FONT.body },
});

function RulePill({ label, selected, onPress, testID }: { label: string; selected: boolean; onPress: () => void; testID?: string }) {
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      style={[ruleBuilderStyles.pill, { backgroundColor: selected ? tint(C.accentAlt, 0.14) : C.card, borderColor: selected ? C.accent : C.hairline }]}
    >
      <Text style={[ruleBuilderStyles.pillText, { color: selected ? C.textBright : C.textMid }]}>{label}</Text>
    </Pressable>
  );
}

function AddRuleSheet() {
  const s = useAppContext(); // sheet + updateRule + saveManualRule (writers)
  const { rules } = useRulesScreenData();
  const { categories: cats, isLoading: catsLoading, isError: catsError, category } = useCategories();
  // WHIT-563: the account-condition options — the synced-account SET (live balances) named from the
  // recent transactions (accountSummaries is the only source of account names), mirroring the goal-
  // edit picker (app/goal/edit.tsx). The stored condition value is the account_id the engine matches.
  const { transactions, balances } = useRecentTransactionsScreenData();
  const accountNameById = new Map(accountSummaries({ transactions }).map((a) => [a.id, a.name]));
  const accountIds = new Set<string>(accountNameById.keys());
  for (const b of balances.values()) accountIds.add(b.account_id);
  const accountOptions = [...accountIds].map((id) => ({ id, name: accountNameById.get(id) ?? id }));
  const sh = s.sheet;
  // ruleId present -> editing an existing rule; prefill from it. The sheet is
  // keyed on ruleId (see SheetHost), so it remounts per rule and these initialisers re-run.
  const editing = sh?.mode === 'addrule' && sh.ruleId ? rules.find((r) => r.id === sh.ruleId) : undefined;
  // WHIT-277: survive a Face ID lock — restore any draft stashed before the lock, else fall back to
  // today's prefill. Lazy init runs once on (re)mount, so the unlock remount reads back the stash.
  const draftKey = `addrule:${(sh?.mode === 'addrule' ? sh.ruleId : undefined) ?? 'new'}`;
  const [draft, setDraft] = useSheetDraft<RuleDraft>(
    draftKey,
    (stored) => {
      // WHIT-563: tolerate a pre-migration draft (the old {pattern, categoryId} shape) restored after
      // an app update mid-edit — treat its pattern as one description-contains row so unlock never
      // crashes. Otherwise: a stored multi draft > the edited rule's conditions > a synthesised single
      // row from a flat/legacy rule > one blank row for a brand-new rule.
      const legacyPattern = (stored as unknown as { pattern?: string } | undefined)?.pattern;
      const conditions: DraftCondition[] =
        stored?.conditions?.length ? stored.conditions
        : legacyPattern != null ? [{ field: 'description', operator: 'contains', value: legacyPattern }]
        : editing?.conditions?.length ? editing.conditions.map((c) => ({ field: c.field, operator: c.operator, value: c.value }))
        : editing ? [{ field: editing.field ?? 'description', operator: editing.operator ?? 'contains', value: editing.pattern ?? '' }]
        : [{ field: 'description', operator: 'contains', value: '' }];
      return {
        conditions,
        logic: stored?.logic ?? editing?.logic ?? 'all',
        categoryId: stored?.categoryId ?? editing?.categoryId ?? null,
        budgetExcluded: stored?.budgetExcluded ?? editing?.budgetExcluded ?? false,
      };
    },
  );
  const { conditions, logic, categoryId, budgetExcluded } = draft;
  const setCategoryId = (value: string | null) => setDraft((prev) => (prev.categoryId === value ? prev : { ...prev, categoryId: value }));
  const setBudgetExcluded = (value: boolean) => setDraft((prev) => (prev.budgetExcluded === value ? prev : { ...prev, budgetExcluded: value }));
  const setLogic = (value: RuleLogic) => setDraft((prev) => (prev.logic === value ? prev : { ...prev, logic: value }));
  const updateCondition = (index: number, patch: Partial<DraftCondition>) =>
    setDraft((prev) => ({ ...prev, conditions: prev.conditions.map((c, i) => (i === index ? { ...c, ...patch } : c)) }));
  const changeField = (index: number, field: string) => {
    // A field switch resets the operator to that field's default and clears the value (direction
    // seeds to spending so the row isn't invalid-empty by surprise).
    const operator = RULE_FIELD_OPERATORS[field][0];
    updateCondition(index, { field, operator, value: field === 'direction' ? 'debit' : '' });
  };
  const addCondition = () => setDraft((prev) => ({ ...prev, conditions: [...prev.conditions, { field: 'description', operator: 'contains', value: '' }] }));
  const removeCondition = (index: number) =>
    setDraft((prev) => (prev.conditions.length <= 1 ? prev : { ...prev, conditions: prev.conditions.filter((_, i) => i !== index) }));
  // WHIT-284: once the category list has LOADED, drop a restored/prefilled categoryId that no longer
  // exists (its category was deleted — e.g. on another device while locked). Gate on `!catsLoading`
  // (NOT cats.length: an empty list is ambiguous — the last-category-deleted case would be missed)
  // and `!catsError` (a cold-load error also reports loaded+empty, and dropping there would wrongly
  // wipe a valid id). setCategoryId(null) routes through the persist effect so the dead id is
  // scrubbed from the stored draft too.
  useEffect(() => {
    if (!catsLoading && !catsError && categoryId && !cats.some((c) => c.id === categoryId)) setCategoryId(null);
  }, [catsLoading, catsError, cats, categoryId]);
  // Alphabetical so a newly-created category isn't stranded at the bottom (WHIT-158).
  const categories = [...cats].sort((a, b) => a.name.localeCompare(b.name));
  const classic = isClassicSingle(conditions);
  const primaryValue = conditions[0].value.trim();
  // WHIT-284: save needs a REAL category; WHIT-563: every condition must be valid for its field.
  const canSave = !!category(categoryId) && conditions.every(conditionValid);
  // WHIT-355: a pending clash with an existing rule — only meaningful on the classic single path
  // (a multi rule has no single pattern; the server's id-keyed store dedups those). Local (not
  // persisted), so a Face-ID lock that drops it just re-shows on the next submit.
  const [conflict, setConflict] = useState<RuleConflict | null>(null);
  // Editing the conditions/category invalidates a pending conflict decision: clear it so the warning
  // can't show a stale pattern or clobber a rule the user has moved off.
  const conditionsKey = JSON.stringify(conditions);
  useEffect(() => { if (conflict) setConflict(null); }, [conditionsKey, categoryId]);

  const writeClassic = () => {
    if (editing) { s.updateRule(editing.id, primaryValue, categoryId!, budgetExcluded); return; }
    // WHIT-538: a NEW classic rule goes through the preview/confirm step, which owns the save.
    s.setSheet({ mode: 'addRuleConfirm', pattern: primaryValue, categoryId: categoryId!, budgetExcluded });
  };
  // The conditions as the server stores them: trimmed values, field/operator only. Shared by the
  // overlap check (submit) and the write (writeMulti) so the two can't drift.
  const cleanedConditions = (): RuleCondition[] =>
    conditions.map((c) => ({ field: c.field, operator: c.operator, value: c.value.trim() }));
  const writeMulti = () => {
    const cleaned = cleanedConditions();
    const write: RuleWrite = { conditions: cleaned, logic };
    // WHIT-563: a multi-condition new rule saves directly (the preview/confirm chain is pattern-only).
    if (editing) s.updateRule(editing.id, cleaned[0].value, categoryId!, budgetExcluded, write);
    else s.saveManualRule(cleaned[0].value, categoryId!, budgetExcluded, write);
  };
  // WHIT-562: the user chose to save despite the overlap warning — clear it and save.
  const saveMultiAnyway = () => { setConflict(null); writeMulti(); };
  const submit = () => {
    if (!canSave) return;
    if (classic) {
      // Stop a silent duplicate/clashing rule (WHIT-355): warn instead of minting a second row.
      const found = ruleConflict(rules, primaryValue, categoryId!, editing?.id);
      if (found) { setConflict(found); return; }
      writeClassic();
      return;
    }
    // WHIT-562: a multi rule has no single pattern to identity-match, so warn (don't block) when it
    // can co-match a charge with an existing rule that files elsewhere — those charges would sit
    // unfiled. Conservative: only fires on a provable overlap, so it never blocks a valid rule.
    const overlap = ruleOverlap(rules, cleanedConditions(), logic, categoryId!, editing?.id);
    if (overlap) { setConflict(overlap); return; }
    writeMulti();
  };
  // Replace is only offered when CREATING a classic rule: retarget the existing rule so exactly one
  // row survives. On the edit path a "replace" would strand the rule being edited, so edit clashes
  // are warn + cancel only.
  const replace = () => { if (conflict) s.updateRule(conflict.existing.id, primaryValue, categoryId!, budgetExcluded); };
  const existingName = conflict ? (category(conflict.existing.categoryId)?.name ?? 'another category') : '';
  const conflictBlock = () => {
    if (!conflict) return null;
    if (conflict.kind === 'overlap') {
      // WHIT-562: a soft warning — the user can save anyway. Names the category the existing rule
      // files as, so the clash is concrete.
      const overlapName = category(conflict.existing.categoryId)?.name ?? 'another category';
      return (
        <View style={styles.ruleConflict} testID="rule-overlap">
          <Text style={styles.ruleConflictText}>This can clash with a rule that files as {overlapName}. Charges matching both may stay unfiled.</Text>
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
            <Pressable testID="rule-overlap-save" onPress={saveMultiAnyway} style={[styles.btn, { flex: 1, backgroundColor: C.accent }]}>
              <Text style={[styles.btnPrimaryText, { color: C.accentInk }]}>Save anyway</Text>
            </Pressable>
            <Pressable testID="rule-overlap-cancel" onPress={() => setConflict(null)} style={[styles.btn, styles.btnGhost, { flex: 1 }]}>
              <Text style={styles.btnGhostText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      );
    }
    if (editing) {
      return (
        <View style={styles.ruleConflict} testID="rule-conflict">
          <Text style={styles.ruleConflictText}>Another rule already matches “{primaryValue}”. Edit or delete that rule instead.</Text>
          <Pressable testID="rule-conflict-ok" onPress={() => setConflict(null)} style={[styles.btn, styles.btnGhost, { marginTop: 12 }]}>
            <Text style={styles.btnGhostText}>OK</Text>
          </Pressable>
        </View>
      );
    }
    if (conflict.kind === 'duplicate') {
      return (
        <View style={styles.ruleConflict} testID="rule-conflict">
          <Text style={styles.ruleConflictText}>You already have a rule for “{primaryValue}”.</Text>
          <Pressable testID="rule-conflict-ok" onPress={() => s.setSheet(null)} style={[styles.btn, styles.btnGhost, { marginTop: 12 }]}>
            <Text style={styles.btnGhostText}>OK</Text>
          </Pressable>
        </View>
      );
    }
    return (
      <View style={styles.ruleConflict} testID="rule-conflict">
        <Text style={styles.ruleConflictText}>“{primaryValue}” already files as {existingName}.</Text>
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
          <Pressable testID="rule-conflict-replace" onPress={replace} style={[styles.btn, { flex: 1, backgroundColor: C.accent }]}>
            <Text style={[styles.btnPrimaryText, { color: C.accentInk }]}>Replace</Text>
          </Pressable>
          <Pressable testID="rule-conflict-cancel" onPress={() => setConflict(null)} style={[styles.btn, styles.btnGhost, { flex: 1 }]}>
            <Text style={styles.btnGhostText}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    );
  };

  const renderValueControl = (condition: DraftCondition, index: number) => {
    if (condition.field === 'amount') {
      return (
        <TextInput
          value={condition.value}
          onChangeText={(t) => updateCondition(index, { value: t })}
          keyboardType="decimal-pad"
          placeholder="e.g. 30"
          placeholderTextColor={C.placeholder}
          style={[styles.input, { marginTop: 8 }]}
          testID={`rule-value-${index}`}
        />
      );
    }
    if (condition.field === 'direction') {
      return (
        <View style={[ruleBuilderStyles.pillWrap, { marginTop: 8 }]}>
          {RULE_DIRECTIONS.map((dir) => (
            <RulePill key={dir} label={DIRECTION_LABELS[dir]} selected={condition.value === dir} onPress={() => updateCondition(index, { value: dir })} testID={`rule-direction-${index}-${dir}`} />
          ))}
        </View>
      );
    }
    if (condition.field === 'account') {
      const options = accountOptions.some((o) => o.id === condition.value) || !condition.value
        ? accountOptions
        : [...accountOptions, { id: condition.value, name: accountNameById.get(condition.value) ?? condition.value }];
      if (options.length === 0) {
        return <Text style={[styles.cycleSectionHint, { marginTop: 8 }]}>No linked accounts yet.</Text>;
      }
      return (
        <View style={[ruleBuilderStyles.pillWrap, { marginTop: 8 }]}>
          {options.map((opt) => (
            <RulePill key={opt.id} label={opt.name} selected={condition.value === opt.id} onPress={() => updateCondition(index, { value: opt.id })} testID={`rule-account-${index}-${opt.id}`} />
          ))}
        </View>
      );
    }
    // description / merchant / category — a text value.
    return (
      <TextInput
        value={condition.value}
        onChangeText={(t) => updateCondition(index, { value: t })}
        autoCapitalize="characters"
        placeholder="e.g. NETFLIX"
        placeholderTextColor={C.placeholder}
        style={[styles.input, { marginTop: 8 }]}
        testID={`rule-value-${index}`}
      />
    );
  };

  const renderCondition = (condition: DraftCondition, index: number) => {
    const fieldOptions: string[] = BUILDER_FIELDS.includes(condition.field as BuilderField) ? [...BUILDER_FIELDS] : [...BUILDER_FIELDS, condition.field];
    const operators = RULE_FIELD_OPERATORS[condition.field] ?? [];
    return (
      <View key={index} style={ruleBuilderStyles.conditionCard} testID={`rule-condition-${index}`}>
        <View style={ruleBuilderStyles.pillWrap}>
          {fieldOptions.map((field) => (
            <RulePill key={field} label={FIELD_LABELS[field] ?? field} selected={condition.field === field} onPress={() => changeField(index, field)} testID={`rule-field-${index}-${field}`} />
          ))}
        </View>
        {operators.length > 1 && (
          <View style={[ruleBuilderStyles.pillWrap, { marginTop: 4 }]}>
            {operators.map((operator) => (
              <RulePill key={operator} label={OPERATOR_LABELS[operator] ?? operator} selected={condition.operator === operator} onPress={() => updateCondition(index, { operator })} testID={`rule-op-${index}-${operator}`} />
            ))}
          </View>
        )}
        {renderValueControl(condition, index)}
        {conditions.length > 1 && (
          <Pressable testID={`rule-remove-${index}`} onPress={() => removeCondition(index)} style={ruleBuilderStyles.removeRow}>
            <Text style={ruleBuilderStyles.removeText}>Remove</Text>
          </Pressable>
        )}
      </View>
    );
  };

  return (
    <View>
      <Text style={styles.sheetTitle}>{editing ? 'Edit rule' : 'New rule'}</Text>
      <Text style={styles.fieldLabel}>WHEN A CHARGE MATCHES</Text>
      <ScrollView style={{ maxHeight: 300 }}>
        {conditions.map((condition, index) => (
          <View key={index}>
            {index > 0 && <Text style={ruleBuilderStyles.connector}>{logic === 'all' ? 'AND' : 'OR'}</Text>}
            {renderCondition(condition, index)}
          </View>
        ))}
      </ScrollView>
      <Pressable testID="rule-add-condition" onPress={addCondition} style={[styles.btn, styles.btnGhost, { marginTop: 10 }]}>
        <Text style={styles.btnGhostText}>+ Add condition</Text>
      </Pressable>
      {conditions.length > 1 && (
        <>
          <Text style={[styles.fieldLabel, { marginTop: 14 }]}>MATCH</Text>
          <View style={[ruleBuilderStyles.pillWrap, { marginTop: 6 }]}>
            <RulePill label="All conditions" selected={logic === 'all'} onPress={() => setLogic('all')} testID="rule-logic-all" />
            <RulePill label="Any condition" selected={logic === 'any'} onPress={() => setLogic('any')} testID="rule-logic-any" />
          </View>
        </>
      )}
      <Text style={[styles.fieldLabel, { marginTop: 14 }]}>FILE IT AS</Text>
      <ScrollView style={{ maxHeight: 200, marginTop: 6 }}>
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
        onPress={() => setBudgetExcluded(!budgetExcluded)}
        testID="rule-budget-excluded"
        style={[styles.cycleRow, { marginTop: 14, backgroundColor: budgetExcluded ? tint(C.accentAlt, 0.14) : C.cardAlt, borderColor: budgetExcluded ? C.accent : C.hairline }]}
      >
        <Text style={[styles.cycleText, { color: budgetExcluded ? C.accentSofter : C.textMid }]}>Keep out of budget</Text>
        {budgetExcluded && <Glyph name="check" size={18} color={C.accent} />}
      </Pressable>
      <Text style={styles.cycleSectionHint}>Charges this rule files won’t count toward your budget — for reimbursed spend or transfers.</Text>
      {conflict ? conflictBlock() : (
        <Pressable
          onPress={submit}
          testID="rule-submit"
          style={[styles.btn, { marginTop: 16, backgroundColor: canSave ? C.accent : tint(C.accentAlt, 0.25) }]}
        >
          <Text style={[styles.btnPrimaryText, { color: canSave ? C.accentInk : '#6a6a90' }]}>{editing ? 'Update rule' : 'Add rule'}</Text>
        </Pressable>
      )}
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
              style={[styles.cycleRow, { backgroundColor: sel ? tint(C.accentAlt, 0.14) : C.cardAlt, borderColor: sel ? C.accent : 'rgba(255,255,255,.07)' }]}
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
      // Carry the ladder through so the instant on-screen update keeps showing it (the server
      // keeps an omitted ladder, but the optimistic row wouldn't) — WHIT-476.
      checkpoints: goal.checkpoints ?? undefined,
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

// WHIT-508: preview the user's existing rules against charges already stored, then file them.
//
// BankSync only runs rules as a transaction ARRIVES, so history never gets re-labelled. This is
// the catch-up pass. It previews on mount (writing nothing) so an over-eager rule — "ALDI" also
// catching VIVALDI — is visible BEFORE anything is written, which is the whole point of the sheet.
//
// It reads and writes only through the context actions, never src/api.ts directly: that keeps the
// session-epoch bail every other awaited call gets, and keeps the `../context` mock seam the
// screen tests use.
type ApplyRulesPhase = 'loading' | 'preview' | 'applying' | 'done' | 'stuck' | 'previewFailed' | 'writeFailed';

function ApplyRulesSheet() {
  // The provider's writers are useCallback-stable, so the mount effect below fires exactly once
  // even though the context value's identity changes on every toast.
  const { previewRuleApplication, applyRulesToHistory, applyRulesJob, applyRulesStalled, startApplyRulesSweep, setSheet, showToast } = useAppContext();
  const onRetryJob = useApplyRulesJobRetry();
  const { category } = useCategories();
  const runGuarded = useInFlightGuard();
  // The preview gets its OWN latch, shared by the mount call and "Try again". A preview is a
  // whole-history scan plus a live rules read, so letting an impatient tap start a second one
  // costs real server work — and two in flight could resolve out of order, painting the older
  // answer over the newer. One latch closes both; a separate latch from the write's, so a retry
  // can never block a file (or the reverse).
  const previewGuarded = useInFlightGuard();
  const [report, setReport] = useState<ApplyRulesResult | null>(null);
  const [phase, setPhase] = useState<ApplyRulesPhase>('loading');
  // Filing 639 charges takes several rounds, and each round's report describes only ITS round. Keep
  // the running total here, or the closing toast would announce the last round (39) as the whole job.
  const filedTotal = useRef(0);
  // Rows left over because they ERRORED are re-attempted by the next round against the same failing
  // condition, so "Apply the rest" can offer an identical screen forever. Remember what was left
  // last round: a round that files nothing and shrinks nothing is stuck, not worth another tap.
  const previousStillToGo = useRef<number | null>(null);
  // The sheet is dismissable while a write runs (the backdrop and the drag handle are SheetHost's,
  // not ours), so a run can finish with nothing left to render into. Report it as a toast instead
  // of dropping it silently.
  const onScreen = useRef(true);
  useEffect(() => () => { onScreen.current = false; }, []);

  const runPreview = useCallback(async () => {
    setPhase('loading');
    const result = await previewRuleApplication();
    if (!result) { setPhase('previewFailed'); return; }
    setReport(result);
    setPhase('preview');
  }, [previewRuleApplication]);

  useEffect(() => { previewGuarded(runPreview); }, [previewGuarded, runPreview]);

  // The write RE-PLANS from a fresh scan and a fresh rule list, so its numbers — not the
  // preview's — are the truthful ones afterwards. Replace the report wholesale.
  const onApply = () => runGuarded(async () => {
    setPhase('applying');
    const result = await applyRulesToHistory();
    if (!result) {
      if (onScreen.current) setPhase('writeFailed');
      else showToast("Couldn't finish applying your rules. Some charges may already have been filed.");
      return;
    }
    setReport(result);
    filedTotal.current += result.filed.length;
    // `failed` rows were attempted and so are NOT in `remaining`, but they are still unfiled — a
    // re-run picks them up. Both count as work left.
    const stillToGo = result.remaining + result.failed.length;
    if (stillToGo === 0) {
      setSheet(null);
      showToast(applyRulesDoneMessage(filedTotal.current));
      return;
    }
    const stalled = result.filed.length === 0
      && previousStillToGo.current !== null && stillToGo >= previousStillToGo.current;
    previousStillToGo.current = stillToGo;
    if (!onScreen.current) { showToast(applyRulesRoundMessage(filedTotal.current, stillToGo)); return; }
    setPhase(stalled ? 'stuck' : 'done');
  });

  // WHIT-560: start the uncapped background sweep. On the accepted job the provider takes over —
  // `applyRulesJob` becomes non-null and the job view below renders; a failed start (502/network)
  // just toasts and leaves the preview so she can retry.
  const onStartSweep = () => runGuarded(async () => {
    const outcome = await startApplyRulesSweep();
    if (!outcome.ok) showToast("Couldn't start the background sweep. Please try again.");
  });

  // Once a job is running (or finished), it owns the sheet — its status drives running/done/failed.
  if (applyRulesJob) {
    return <ApplyRulesJobView job={applyRulesJob} stalled={applyRulesStalled} onRetry={onRetryJob} onClose={() => setSheet(null)} />;
  }

  if (phase === 'loading' || phase === 'applying') {
    const label = phase === 'loading' ? 'Checking what your rules would file…' : 'Filing your charges…';
    return (
      <View testID="apply-rules-busy" style={styles.applyRulesBusy}>
        <ActivityIndicator color={C.accent} />
        <Text style={[styles.confirmSub, { marginTop: 14 }]}>{label}</Text>
      </View>
    );
  }

  if (phase === 'previewFailed') {
    return (
      <View>
        <Text style={styles.confirmTitle}>Couldn't read your rules</Text>
        <Text style={styles.confirmSub}>Nothing has been changed. Please try again.</Text>
        <Pressable testID="apply-rules-retry" onPress={() => previewGuarded(runPreview)} style={[styles.btn, styles.btnPrimary]}>
          <Text style={styles.btnPrimaryText}>Try again</Text>
        </Pressable>
        <ApplyRulesCancel label="Cancel" onPress={() => setSheet(null)} />
      </View>
    );
  }

  if (phase === 'writeFailed') {
    return (
      <View>
        <Text style={styles.confirmTitle}>Couldn't finish</Text>
        {/* Deliberately NOT "nothing happened": the server writes row by row and only reports at
            the end, so a dropped connection can leave charges already filed. And deliberately not
            "pull down to refresh" — applyRulesToHistory already refreshed the caches for her. */}
        <Text style={styles.confirmSub}>
          Some charges may already have been filed. Your unfiled list and count have been refreshed — open this again to see what's left.
        </Text>
        <ApplyRulesCancel label="Close" onPress={() => setSheet(null)} />
      </View>
    );
  }

  if (!report) return null;

  // The server returns BEFORE scanning history when there are no rules at all, so `unfiled` is 0
  // even with hundreds of unfiled charges. Branching on `matched === 0` alone would tell her she
  // has nothing to file while the tab behind the sheet visibly shows otherwise.
  if (report.rulesConsidered === 0) {
    return (
      <View>
        <Text style={styles.confirmTitle}>You don't have any rules yet</Text>
        <Text style={styles.confirmSub}>
          Rules come from filing a charge and choosing "All from this merchant". Make one, then come back and it can sweep the rest of your history.
        </Text>
        <ApplyRulesCancel label="Close" onPress={() => setSheet(null)} />
      </View>
    );
  }

  const stillToGo = report.remaining + report.failed.length;

  // A round that filed nothing and left just as much behind will do the same again — the server
  // re-plans from a fresh scan, so nothing self-corrects. Offering "Apply the rest" here is an
  // invitation to tap forever. Say what happened and give her a way out instead.
  if (phase === 'stuck') {
    return (
      <View>
        <Text style={styles.confirmTitle}>Something's stopping these</Text>
        <Text style={styles.confirmSub}>
          {filedTotal.current > 0 ? `Filed ${filedTotal.current} ${chargeNoun(filedTotal.current)} in total. ` : ''}
          The last {stillToGo} wouldn't save, and trying again didn't help. Give it a while, or file them by hand.
        </Text>
        <ApplyRulesCancel label="Close" onPress={() => setSheet(null)} />
      </View>
    );
  }

  // `phase === 'done'` is only ever set from a write's own result, so this reads the write's report.
  if (phase === 'done') {
    // Only blame the cap when the cap actually bit. The server also stops on a wall-clock budget,
    // and rows can be left over because they ERRORED — saying "we file up to 300 at a time" after
    // a run that saved nothing, or that stopped at 12, is a made-up explanation.
    // A row someone filed mid-run was attempted too, so it counts toward the cap. `?? []` because
    // the field is absent on a server that predates it — an old server must not crash a new app.
    const alreadyFiled = (report.alreadyFiled ?? []).length;
    const attempted = report.filed.length + report.vanished.length + report.failed.length
      + alreadyFiled;
    const hitCap = attempted >= APPLY_RULES_MAX_WRITES;
    return (
      <View>
        <Text style={styles.confirmTitle}>
          {filedTotal.current === 0
            ? "Couldn't file any this time"
            : `Filed ${filedTotal.current} ${chargeNoun(filedTotal.current)} so far`}
        </Text>
        <Text style={styles.confirmSub}>
          {stillToGo} still to go
          {report.failed.length > 0 ? ` (${report.failed.length} we couldn't save)` : ''}
          {hitCap ? ` — we file up to ${APPLY_RULES_MAX_WRITES} at a time.` : '.'}
          {/* A SEPARATE sentence, not a second parenthetical: `failed` rows are INSIDE the
              still-to-go number and these are OUTSIDE it, so hanging both off the same figure
              would give a reader no way to tell which is which. Without this line at all, a round
              that skipped 40 charges because SHE filed them reads as "Couldn't file any this
              time" — accurate, and it looks broken. */}
          {alreadyFiled > 0
            ? ` You'd already filed ${alreadyFiled} ${chargeNoun(alreadyFiled)} yourself.`
            : ''}
        </Text>
        <Pressable testID="apply-rules-continue" onPress={onApply} style={[styles.btn, styles.btnPrimary]}>
          <Text style={styles.btnPrimaryText}>Apply the rest</Text>
        </Pressable>
        <ApplyRulesCancel label="Done for now" onPress={() => setSheet(null)} />
      </View>
    );
  }

  // `matched === 0` does NOT mean the rules missed. A rule's hits are counted before the conflict
  // check, so two rules that disagree on every charge give matched 0 with a non-empty breakdown;
  // and a rule that was skipped was never evaluated at all. Claiming "none of your rules match"
  // would contradict the very breakdown printed underneath it.
  if (report.matched === 0) {
    const applicable = report.rulesConsidered - report.skippedRules.length;
    return (
      <View>
        <Text style={styles.confirmTitle}>Nothing to file automatically</Text>
        <Text style={styles.confirmSub}>{nothingToFileReason(report, applicable)}</Text>
        <ApplyRulesDetail report={report} category={category} />
        <ApplyRulesCancel label="Close" onPress={() => setSheet(null)} />
      </View>
    );
  }

  const capped = report.matched > APPLY_RULES_MAX_WRITES;
  return (
    <View>
      <Text style={styles.confirmTitle}>Apply my rules</Text>
      <Text style={styles.confirmSub}>
        Your rules can file {report.matched} of your {report.unfiled} unfiled {chargeNoun(report.unfiled)}.
        {capped ? ' Filing them all runs in the background — you can leave and it keeps going.' : ''}
      </Text>
      <ApplyRulesDetail report={report} category={category} />
      {/* WHIT-560: over the per-call cap, the uncapped background sweep is the primary action and the
          one-round instant file is demoted; at or under the cap, one instant file is all it takes. */}
      {capped ? (
        <>
          <Pressable testID="apply-rules-apply-all" onPress={onStartSweep} style={[styles.btn, styles.btnPrimary]}>
            <Text style={styles.btnPrimaryText}>Apply to all history</Text>
          </Pressable>
          <Pressable testID="apply-rules-apply" onPress={onApply} style={[styles.btn, styles.btnGhost]}>
            <Text style={styles.btnGhostText}>File up to {APPLY_RULES_MAX_WRITES} now</Text>
          </Pressable>
        </>
      ) : (
        <Pressable testID="apply-rules-apply" onPress={onApply} style={[styles.btn, styles.btnPrimary]}>
          <Text style={styles.btnPrimaryText}>File {report.matched} {chargeNoun(report.matched)}</Text>
        </Pressable>
      )}
      <ApplyRulesCancel label="Cancel" onPress={() => setSheet(null)} />
    </View>
  );
}

/** "charge"/"charges" — the noun every count in this sheet takes. */
function chargeNoun(count: number): string {
  return count === 1 ? 'charge' : 'charges';
}

// WHIT-560: "Try again" on a failed job, shared by all three apply-rules sheets. It re-runs the
// ORIGINAL variant via the provider (retryApplyRulesJob restarts whatever started the job — sweep /
// file-this-shop / add-rule), and toasts if the restart itself fails (a repeat 502, or the lock).
// One hook so the failed-retry feedback is identical wherever the (global) job view is rendered.
function useApplyRulesJobRetry(): () => Promise<void> {
  const { retryApplyRulesJob, showToast } = useAppContext();
  const runGuarded = useInFlightGuard();
  return useCallback(() => runGuarded(async () => {
    const outcome = await retryApplyRulesJob();
    if (!outcome.ok) showToast("Couldn't start the background sweep. Please try again.");
  }), [retryApplyRulesJob, showToast, runGuarded]);
}

// WHIT-560: the running/done/failed view of an async "apply rules over all history" job, shared by
// the plain sweep and the two inline "file this shop / add rule" entry points. Retry is centralized
// in the provider (see useApplyRulesJobRetry), so every host passes the same variant-aware `onRetry`.
// The status comes from the provider's poll loop; leaving the sheet stops polling but the job keeps
// running server-side.
function ApplyRulesJobView({ job, stalled, onRetry, onClose }: { job: ApplyRulesJob; stalled: boolean; onRetry: () => void; onClose: () => void }) {
  if (job.status === 'running') {
    // matched is 0 until the worker has planned (the first poll after the POST) — show an
    // indeterminate "Starting…" until then, and a real bar once the denominator lands.
    const pct = job.matched > 0 ? Math.min(100, Math.round((job.filed / job.matched) * 100)) : null;
    // WHIT-565: a job that has made no progress for a while is not stopped — it keeps running in
    // the background. Show a reassuring "taking longer" hint plus an optional Try again.
    return (
      <View testID={stalled ? 'apply-rules-job-stalled' : 'apply-rules-job-running'}>
        <Text style={styles.confirmTitle}>{stalled ? 'This is taking longer than expected' : 'Filing your charges…'}</Text>
        <Text style={styles.confirmSub}>
          {stalled
            ? 'Still working — a big history can take a while. You can keep waiting, or try again.'
            : job.matched > 0
              ? `Filed ${job.filed} of ${job.matched} ${chargeNoun(job.matched)}. You can leave — this keeps going in the background.`
              : 'Starting… you can leave this running in the background.'}
        </Text>
        {pct !== null && (
          <View testID="apply-rules-job-progress" style={styles.jobProgressTrack}>
            <View style={[styles.jobProgressFill, { width: `${pct}%` }]} />
          </View>
        )}
        {stalled && (
          <Pressable testID="apply-rules-job-stalled-retry" onPress={onRetry} style={[styles.btn, styles.btnPrimary]}>
            <Text style={styles.btnPrimaryText}>Try again</Text>
          </Pressable>
        )}
        <ApplyRulesCancel label="Leave running" onPress={onClose} />
      </View>
    );
  }

  if (job.status === 'succeeded') {
    const already = job.alreadyFiled > 0
      ? ` You'd already filed ${job.alreadyFiled} ${chargeNoun(job.alreadyFiled)} yourself.`
      : '';
    return (
      <View testID="apply-rules-job-done">
        <Text style={styles.confirmTitle}>
          {job.filed === 0 ? 'Nothing left to file' : `Filed ${job.filed} ${chargeNoun(job.filed)}`}
        </Text>
        <Text style={styles.confirmSub}>
          {job.filed === 0
            ? `Your rules had nothing new to file across your history.${already}`
            : `Your rules have been applied across all your history.${already}`}
        </Text>
        <ApplyRulesCancel label="Done" onPress={onClose} />
      </View>
    );
  }

  // Failed: a real server failure, an expired job (its id aged out), or too many dropped polls.
  return (
    <View testID="apply-rules-job-failed">
      <Text style={styles.confirmTitle}>Couldn't finish</Text>
      <Text style={styles.confirmSub}>
        {job.error === 'expired'
          ? 'This run timed out before it finished. '
          : 'Something interrupted the run. '}
        Some charges may already have been filed, and your lists have been refreshed — try again to file the rest.
      </Text>
      <Pressable testID="apply-rules-job-retry" onPress={onRetry} style={[styles.btn, styles.btnPrimary]}>
        <Text style={styles.btnPrimaryText}>Try again</Text>
      </Pressable>
      <ApplyRulesCancel label="Close" onPress={onClose} />
    </View>
  );
}

// WHIT-517: "File by shop" step 1 — the shops (merchant groups) behind unfiled charges, biggest
// first. Tapping a shop swaps this same sheet to a category tree; picking a category advances to
// FileByShopConfirmSheet with the shop + category captured. The button that opens this only shows
// when there is at least one rule-able shop, so the loading/error/empty arms here are the rare
// background-refetch cases, not the normal open.
function FileByShopListSheet() {
  const s = useAppContext();
  const { merchants, isLoading, isError } = useUncategorizedMerchants();
  const { categories: cats } = useCategories();
  // Which shop the user tapped: null → the shop list, set → the category tree for that shop.
  const [selectedGroup, setSelectedGroup] = useState<UncategorizedMerchantGroup | null>(null);
  // Folded parents in the category tree (same expand-by-default model as PickerSheet).
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = useCallback((id: string) => setCollapsed((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  }), []);

  if (isLoading && !merchants) {
    return (
      <View testID="file-by-shop-busy" style={styles.applyRulesBusy}>
        <ActivityIndicator color={C.accent} />
        <Text style={[styles.confirmSub, { marginTop: 14 }]}>Finding your shops…</Text>
      </View>
    );
  }

  if (isError || !merchants) {
    return (
      <View>
        <Text style={styles.confirmTitle}>Couldn't load your shops</Text>
        <Text style={styles.confirmSub}>Nothing has been changed. Please pull down to refresh and try again.</Text>
        <Pressable testID="file-by-shop-close" onPress={() => s.setSheet(null)} style={[styles.btn, styles.btnGhost]}>
          <Text style={styles.btnGhostText}>Close</Text>
        </Pressable>
      </View>
    );
  }

  // Every shop filed (e.g. after filing the last one and returning here). The button that opens
  // this is gated on groups > 0, so this is only reached mid-session, not on a cold open.
  if (merchants.groups.length === 0) {
    // WHIT-544: the leftover one-offs can't be grouped into a rule (their reference sits in the
    // middle), but they're still selectable in the Uncategorized list. Offer a jump into that
    // list's multi-select instead of leaving the user to tap each one.
    const oneOffCount = merchants.ungrouped.count;
    return (
      <View>
        <Text style={styles.confirmTitle}>Every shop is filed</Text>
        <Text style={styles.confirmSub}>
          {oneOffCount > 0
            ? `Nice work. The last ${oneOffCount} unfiled ${chargeNoun(oneOffCount)} are one-offs — select them on the list to file them together.`
            : 'Nice work — nothing left to file by shop.'}
        </Text>
        {oneOffCount > 0 && (
          <Pressable
            testID="file-by-shop-one-offs"
            onPress={() => { s.requestUncategorizedSelect(); s.setSheet(null); }}
            style={[styles.btn, styles.btnPrimary]}
          >
            <Text style={styles.btnPrimaryText}>Select to file</Text>
          </Pressable>
        )}
        <Pressable
          testID="file-by-shop-close"
          onPress={() => s.setSheet(null)}
          style={[styles.btn, oneOffCount > 0 ? styles.btnGhost : styles.btnPrimary]}
        >
          <Text style={oneOffCount > 0 ? styles.btnGhostText : styles.btnPrimaryText}>Done</Text>
        </Pressable>
      </View>
    );
  }

  // A shop is chosen: pick the category to file it (and every future charge from it) under.
  if (selectedGroup) {
    const treeRows = categoryTreeRows(cats);
    const visibleIds = new Set<string>();
    for (const row of treeRows) {
      if (row.parentId === null || (visibleIds.has(row.parentId) && !collapsed.has(row.parentId))) {
        visibleIds.add(row.category.id);
      }
    }
    const visibleRows = treeRows.filter((row) => visibleIds.has(row.category.id));
    return (
      <View>
        <Pressable testID="file-by-shop-back" onPress={() => setSelectedGroup(null)} hitSlop={8} style={styles.sheetBack}>
          <Glyph name="back" size={15} color={C.textMid} />
          <Text style={styles.sheetBackText}>All shops</Text>
        </Pressable>
        <Text style={styles.sheetTitle}>File {selectedGroup.merchant || 'this shop'} as…</Text>
        <Text style={styles.sheetMerchant}>
          {selectedGroup.count} unfiled {chargeNoun(selectedGroup.count)} — and every future charge from here.
        </Text>
        <ScrollView style={{ maxHeight: 340, marginTop: 12 }}>
          {visibleRows.map(({ category: c, depth, hasChildren }) => {
            const isCollapsed = collapsed.has(c.id);
            return (
              <View
                key={c.id}
                style={[styles.pickRow, depth > 0 && { marginLeft: depth * 18, borderLeftWidth: 2, borderLeftColor: c.color, paddingLeft: 11 }]}
              >
                <Pressable
                  testID="file-by-shop-cat"
                  onPress={() => s.setSheet({ mode: 'fileByShopConfirm', group: selectedGroup, categoryId: c.id })}
                  style={styles.pickNameHit}
                >
                  <View style={[styles.pickChip, { backgroundColor: tint(c.color, 0.15) }]}>
                    <Icon name={c.icon} size={19} color={c.color} />
                  </View>
                  <Text style={styles.pickName}>{c.name}</Text>
                </Pressable>
                {hasChildren && (
                  <Pressable
                    testID={`file-by-shop-cat-toggle-${c.id}`}
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

  // The shop list itself.
  return (
    <View>
      <Text style={styles.sheetTitle}>File by shop</Text>
      <Text style={styles.sheetMerchant}>
        {merchants.unfiled} unfiled {chargeNoun(merchants.unfiled)}, grouped by shop. Pick a shop to file all its charges — and make a rule so future ones file themselves.
      </Text>
      <ScrollView style={styles.applyRulesScroll}>
        {merchants.groups.map((group) => (
          <Pressable
            key={group.rulePattern}
            testID="file-by-shop-group"
            onPress={() => setSelectedGroup(group)}
            style={styles.pickRow}
          >
            <View style={styles.fileByShopGroupText}>
              <Text style={styles.applyRulesRuleText} numberOfLines={1}>{group.merchant || group.rulePattern}</Text>
              {group.samples.filter((sample) => sample).slice(0, 1).map((sample, index) => (
                <Text key={index} style={styles.applyRulesSample} numberOfLines={1}>{sample}</Text>
              ))}
              {group.alsoCatches.length > 0 && (
                <Text style={styles.applyRulesSample} numberOfLines={1}>
                  + also files {alsoCatchesTotal(group)} from {group.alsoCatches.length} other {group.alsoCatches.length === 1 ? 'shop' : 'shops'}
                </Text>
              )}
            </View>
            <Text style={styles.fileByShopCount}>{group.count}</Text>
            <Glyph name="chevron" size={15} color={C.textFaint} />
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

/** The charges this group's rule would ALSO sweep from other shops — the over-broad-rule number. */
function alsoCatchesTotal(group: UncategorizedMerchantGroup): string {
  const total = group.alsoCatches.reduce((sum, other) => sum + other.count, 0);
  return `${total} ${chargeNoun(total)}`;
}

// WHIT-517: "File by shop" step 2 — preview then file one shop. On open it dry-runs the mint+file
// so it can show the real count (what the rule ACTUALLY sweeps, including other shops) before any
// write. A clash (an existing rule already files this shop elsewhere) surfaces here, from the
// server's own check, so there is nothing to write; the write path re-checks in case a rule was
// made between preview and confirm.
type ConfirmPhase = 'loading' | 'preview' | 'clash' | 'previewFailed' | 'confirming' | 'writeFailed';

// What a wrapper's renderArm receives. The shell owns the phase machine and the two latches; the
// wrapper renders every visible arm from these. `onCommit` runs the primary write; `runCommit` runs
// any action (e.g. AddRule's "rule only" save) through the SAME commit latch, so the two can never
// both fire in one frame; `retry` re-runs the preview.
type ConfirmArm = {
  phase: ConfirmPhase;
  report: ApplyRulesResult | null;
  onCommit: () => void;
  runCommit: (action: () => Promise<unknown> | unknown) => void;
  retry: () => void;
};

type ConfirmPreviewSheetProps = {
  // `preview` feeds the mount effect, so it MUST be a useCallback in the wrapper — an unstable
  // identity would re-fire the preview and snap the sheet back to its spinner (WHIT-538). The rest
  // are read at press time and need no memoisation.
  preview: () => Promise<FileByShopOutcome>;
  commit: () => Promise<FileByShopOutcome>;
  filedToast: (report: ApplyRulesResult) => void; // always fired on success — on screen or not
  onNavigate: () => void;                          // only when the sheet is still on screen
  clashToast: () => void;                          // only when dismissed mid-write
  writeFailedToast: () => void;                    // only when dismissed mid-write
  renderArm: (arm: ConfirmArm) => React.ReactNode;
};

// WHIT-557: the shared shell behind FileByShopConfirmSheet and AddRuleConfirmSheet (both WHIT-538).
// Owns the phase machine, the two independent in-flight latches (preview + commit), the on-screen
// ref, the preview-on-mount effect, and the commit writer. Each wrapper supplies its preview/commit
// callbacks, its copy (toasts + navigation), and a renderArm for the visible arms — keeping every
// arm's testID and string verbatim in the wrapper, so the two sheets behave exactly as before.
function ConfirmPreviewSheet({ preview, commit, filedToast, onNavigate, clashToast, writeFailedToast, renderArm }: ConfirmPreviewSheetProps) {
  const runGuarded = useInFlightGuard();
  const previewGuarded = useInFlightGuard();
  const [report, setReport] = useState<ApplyRulesResult | null>(null);
  const [phase, setPhase] = useState<ConfirmPhase>('loading');
  // The sheet is dismissable mid-write (backdrop + drag are SheetHost's), so a run can finish with
  // nothing on screen — report it as a toast instead of dropping it.
  const onScreen = useRef(true);
  useEffect(() => () => { onScreen.current = false; }, []);

  const runPreview = useCallback(async () => {
    setPhase('loading');
    const outcome = await preview();
    if (outcome.ok) { setReport(outcome.report); setPhase('preview'); return; }
    setPhase(outcome.clash ? 'clash' : 'previewFailed');
  }, [preview]);

  useEffect(() => { previewGuarded(runPreview); }, [previewGuarded, runPreview]);

  const onCommit = () => runGuarded(async () => {
    setPhase('confirming');
    const outcome = await commit();
    if (outcome.ok) {
      filedToast(outcome.report);            // always — never drop a result the user can't see
      if (onScreen.current) onNavigate();    // only navigate a sheet that's still on screen
      return;
    }
    if (outcome.clash) { if (onScreen.current) setPhase('clash'); else clashToast(); return; }
    if (onScreen.current) setPhase('writeFailed'); else writeFailedToast();
  });

  return <>{renderArm({ phase, report, onCommit, runCommit: runGuarded, retry: () => previewGuarded(runPreview) })}</>;
}

function FileByShopConfirmSheet() {
  // Destructure the STABLE context callbacks (each a useCallback), NOT the whole context value:
  // the value's identity changes on every toast (auto-clears 3.4s later), and a preview built off
  // the whole value would re-fire and snap the sheet back to its spinner. `sheet` only changes when
  // setSheet is called (a toast never touches it), so the memoised `preview` below stays stable.
  const { sheet, previewFileByShop, fileByShop, applyRulesJob, applyRulesStalled, startFileByShopJob, setSheet, showToast } = useAppContext();
  const { category } = useCategories();
  const onRetryJob = useApplyRulesJobRetry();
  const group = sheet?.mode === 'fileByShopConfirm' ? sheet.group : null;
  const categoryId = sheet?.mode === 'fileByShopConfirm' ? sheet.categoryId : null;
  // Non-null-asserted: the guard below returns null before the shell mounts, so `preview` is never
  // invoked while group/categoryId are null. useCallback must precede the early return (hooks rule).
  const preview = useCallback(
    () => previewFileByShop(group!, categoryId!),
    [previewFileByShop, group, categoryId],
  );

  if (!group || !categoryId) return null;
  const chosen = category(categoryId);
  if (!chosen) return null;

  // WHIT-560: once a background sweep for this shop is running (or finished), it owns the sheet.
  if (applyRulesJob) {
    return <ApplyRulesJobView job={applyRulesJob} stalled={applyRulesStalled} onRetry={onRetryJob} onClose={() => setSheet(null)} />;
  }

  return (
    <ConfirmPreviewSheet
      preview={preview}
      commit={() => fileByShop(group, categoryId)}
      filedToast={(report) => showToast(fileByShopFiledMessage(report, chosen.name, group.merchant))}
      // Back to the shop list, which the write invalidated — the filed shop is gone from it.
      onNavigate={() => setSheet({ mode: 'fileByShopList' })}
      clashToast={() => showToast(`You already have a rule filing ${group.merchant || 'this shop'} somewhere else.`)}
      writeFailedToast={() => showToast(`Couldn't file ${group.merchant || 'this shop'}. Some charges may already have been filed.`)}
      renderArm={({ phase, report, onCommit, runCommit, retry }) => {
        // WHIT-560: a shop bigger than the per-call cap starts the uncapped background sweep instead
        // of the one-round file. A 409 clash or a failed start toasts (the same copy as the sync path).
        const onApplyAll = () => runCommit(async () => {
          const outcome = await startFileByShopJob(group, categoryId);
          if (outcome.ok) return;
          showToast(outcome.clash
            ? `You already have a rule filing ${group.merchant || 'this shop'} somewhere else.`
            : `Couldn't start filing ${group.merchant || 'this shop'}. Please try again.`);
        });
        if (phase === 'loading' || phase === 'confirming') {
          const label = phase === 'loading' ? 'Checking what this would file…' : 'Filing these charges…';
          return (
            <View testID="file-by-shop-confirm-busy" style={styles.applyRulesBusy}>
              <ActivityIndicator color={C.accent} />
              <Text style={[styles.confirmSub, { marginTop: 14 }]}>{label}</Text>
            </View>
          );
        }
        if (phase === 'clash') {
          return (
            <View>
              <Text style={styles.confirmTitle}>You already have a rule for this</Text>
              <Text style={styles.confirmSub}>
                You already have a rule filing {group.merchant || 'this shop'} somewhere else — edit it in Rules to change where these go. Nothing has been changed.
              </Text>
              <Pressable testID="file-by-shop-confirm-close" onPress={() => setSheet({ mode: 'fileByShopList' })} style={[styles.btn, styles.btnGhost]}>
                <Text style={styles.btnGhostText}>Back to shops</Text>
              </Pressable>
            </View>
          );
        }
        if (phase === 'previewFailed') {
          return (
            <View>
              <Text style={styles.confirmTitle}>Couldn't check this shop</Text>
              <Text style={styles.confirmSub}>Nothing has been changed. Please try again.</Text>
              <Pressable testID="file-by-shop-confirm-retry" onPress={retry} style={[styles.btn, styles.btnPrimary]}>
                <Text style={styles.btnPrimaryText}>Try again</Text>
              </Pressable>
              <Pressable testID="file-by-shop-confirm-cancel" onPress={() => setSheet({ mode: 'fileByShopList' })} style={[styles.btn, styles.btnGhost]}>
                <Text style={styles.btnGhostText}>Back to shops</Text>
              </Pressable>
            </View>
          );
        }
        if (phase === 'writeFailed') {
          return (
            <View>
              <Text style={styles.confirmTitle}>Couldn't finish</Text>
              <Text style={styles.confirmSub}>
                Some charges may already have been filed. Your unfiled list has been refreshed — open this again to see what's left.
              </Text>
              <Pressable testID="file-by-shop-confirm-close" onPress={() => setSheet({ mode: 'fileByShopList' })} style={[styles.btn, styles.btnGhost]}>
                <Text style={styles.btnGhostText}>Back to shops</Text>
              </Pressable>
            </View>
          );
        }
        if (!report) return null;

        // `matched` is the truthful count: what the rule ACTUALLY sweeps right now, across every
        // unfiled charge (this shop plus anything in `alsoCatches`). A shop whose charges someone
        // filed between opening the list and here can read 0 — say so rather than offer "File 0".
        if (report.matched === 0) {
          return (
            <View>
              <Text style={styles.confirmTitle}>Nothing left to file here</Text>
              <Text style={styles.confirmSub}>
                These charges from {group.merchant || 'this shop'} were filed already. Pick another shop.
              </Text>
              <Pressable testID="file-by-shop-confirm-close" onPress={() => setSheet({ mode: 'fileByShopList' })} style={[styles.btn, styles.btnPrimary]}>
                <Text style={styles.btnPrimaryText}>Back to shops</Text>
              </Pressable>
            </View>
          );
        }

        const dateRange = fileByShopDateRange(group);
        // The server files at most APPLY_RULES_MAX_WRITES per call, so a shop bigger than that takes
        // more than one tap. Say "up to N now" rather than promise the full matched count.
        const capped = report.matched > APPLY_RULES_MAX_WRITES;
        return (
          <View>
            <View style={[styles.confirmChip, { backgroundColor: tint(chosen.color, 0.16) }]}>
              <Icon name={chosen.icon} size={26} color={chosen.color} />
            </View>
            <Text style={styles.confirmTitle}>File as {chosen.name}</Text>
            <Text style={styles.confirmSub}>
              Files {report.matched} {chargeNoun(report.matched)} from {group.merchant || 'this shop'}
              {dateRange ? ` (${dateRange})` : ''} — and makes a rule so future ones file themselves.
              {capped ? ' Filing them all runs in the background — you can leave and it keeps going.' : ''}
            </Text>
            {group.alsoCatches.length > 0 && (
              <View testID="file-by-shop-also-catches" style={styles.ruleConflict}>
                <Text style={styles.ruleConflictText}>
                  Heads up: this also files charges from {group.alsoCatches.length} other {group.alsoCatches.length === 1 ? 'shop' : 'shops'}.
                </Text>
                {group.alsoCatches.map((other, index) => (
                  <Text key={index} style={styles.applyRulesSample} numberOfLines={1}>
                    {other.merchant || 'Unnamed shop'} — {other.count} {chargeNoun(other.count)}
                  </Text>
                ))}
              </View>
            )}
            {capped ? (
              <>
                <Pressable testID="file-by-shop-confirm-apply-all" onPress={onApplyAll} style={[styles.btn, styles.btnPrimary]}>
                  <Text style={styles.btnPrimaryText}>Apply to all history</Text>
                </Pressable>
                <Pressable testID="file-by-shop-confirm-apply" onPress={onCommit} style={[styles.btn, styles.btnGhost]}>
                  <Text style={styles.btnGhostText}>File up to {APPLY_RULES_MAX_WRITES} now</Text>
                </Pressable>
              </>
            ) : (
              <Pressable testID="file-by-shop-confirm-apply" onPress={onCommit} style={[styles.btn, styles.btnPrimary]}>
                <Text style={styles.btnPrimaryText}>File {report.matched} {chargeNoun(report.matched)}</Text>
              </Pressable>
            )}
            <Pressable testID="file-by-shop-confirm-cancel" onPress={() => setSheet({ mode: 'fileByShopList' })} style={[styles.btn, styles.btnGhost]}>
              <Text style={styles.btnGhostText}>Back to shops</Text>
            </Pressable>
          </View>
        );
      }}
    />
  );
}

/** The toast after a "file by shop" write. Nothing filed → someone beat us to it. A shop bigger than
 *  the per-call cap files in batches, so `matched > cap` means the shop isn't done — say so, since the
 *  shop reappears on the list and she needs to know why (mirrors ApplyRulesSheet's "still to go"). */
function fileByShopFiledMessage(report: ApplyRulesResult, categoryName: string, merchant: string): string {
  const filed = report.filed.length;
  if (filed === 0) return `Nothing left to file for ${merchant || 'this shop'}.`;
  const base = `Filed ${filed} ${chargeNoun(filed)} as ${categoryName}`;
  return report.matched > APPLY_RULES_MAX_WRITES ? `${base} — more of this shop to go, tap it again.` : `${base}.`;
}

/** A "20 Jun 2026 – 4 Aug 2026" range for a group, or a single date, or '' when neither is known. */
function fileByShopDateRange(group: UncategorizedMerchantGroup): string {
  if (!group.firstDate && !group.lastDate) return '';
  if (group.firstDate && group.lastDate && group.firstDate !== group.lastDate) {
    return `${formatDayMonthYear(group.firstDate)} – ${formatDayMonthYear(group.lastDate)}`;
  }
  const only = group.lastDate ?? group.firstDate;
  return only ? formatDayMonthYear(only) : '';
}

// WHIT-538: the confirm step after typing a NEW rule. Previews how many stored charges the typed
// pattern would file (dry run), then either mints the rule + files them (fileNewRule) or saves the
// rule for future charges only (saveManualRule). WHIT-557: routes through the shared
// ConfirmPreviewSheet shell; only its copy, its "rule only" action, and its back/close targets differ.
function AddRuleConfirmSheet() {
  // Destructure the STABLE context callbacks, NOT the whole value: its identity changes on every
  // toast, and a preview built off it would re-fire and snap the sheet back to its spinner. `sheet`
  // only changes when setSheet is called, so the memoised `preview` below stays stable.
  const { sheet, previewNewRule, fileNewRule, saveManualRule, applyRulesJob, applyRulesStalled, startNewRuleJob, setSheet, showToast } = useAppContext();
  const { category } = useCategories();
  const onRetryJob = useApplyRulesJobRetry();
  const pattern = sheet?.mode === 'addRuleConfirm' ? sheet.pattern : null;
  const categoryId = sheet?.mode === 'addRuleConfirm' ? sheet.categoryId : null;
  const budgetExcluded = sheet?.mode === 'addRuleConfirm' ? !!sheet.budgetExcluded : false;
  // Non-null-asserted: the guard below returns null before the shell mounts, so `preview` is never
  // invoked while pattern/categoryId are null. useCallback must precede the early return (hooks rule).
  const preview = useCallback(
    () => previewNewRule(pattern!, categoryId!, budgetExcluded),
    [previewNewRule, pattern, categoryId, budgetExcluded],
  );

  if (!pattern || !categoryId) return null;
  const chosen = category(categoryId);
  if (!chosen) return null;

  // WHIT-560: once the background sweep for this rule is running (or finished), it owns the sheet.
  if (applyRulesJob) {
    return <ApplyRulesJobView job={applyRulesJob} stalled={applyRulesStalled} onRetry={onRetryJob} onClose={() => setSheet(null)} />;
  }

  return (
    <ConfirmPreviewSheet
      preview={preview}
      commit={() => fileNewRule(pattern, categoryId, budgetExcluded)}
      filedToast={(report) => showToast(addRuleFiledMessage(report, chosen.name))}
      onNavigate={() => setSheet(null)}
      clashToast={() => showToast(`You already have a rule for “${pattern}”.`)}
      writeFailedToast={() => showToast(`Couldn't add the rule for “${pattern}”. Some charges may already have been filed.`)}
      renderArm={({ phase, report, onCommit, runCommit, retry }) => {
        // Save the rule for future charges only — the old direct-save path. saveManualRule closes the
        // sheet and shows its own toast. Routed through runCommit (the shell's commit latch, shared
        // with the primary File action) so a same-frame double-tap can't fire both and mint two rules
        // (WHIT-241): saveManualRule has no latch of its own.
        const onRuleOnly = () => runCommit(() => saveManualRule(pattern, categoryId, budgetExcluded));
        const goBack = () => setSheet({ mode: 'addrule' });
        // WHIT-560: a pattern matching more than the per-call cap files its past charges via the
        // uncapped background sweep. A 409 clash or failed start toasts (same copy as the sync path).
        const onApplyAll = () => runCommit(async () => {
          const outcome = await startNewRuleJob(pattern, categoryId, budgetExcluded);
          if (outcome.ok) return;
          showToast(outcome.clash
            ? `You already have a rule for “${pattern}”.`
            : `Couldn't start filing “${pattern}”. Please try again.`);
        });

        if (phase === 'loading' || phase === 'confirming') {
          const label = phase === 'loading' ? 'Checking what this would file…' : 'Adding your rule…';
          return (
            <View testID="add-rule-confirm-busy" style={styles.applyRulesBusy}>
              <ActivityIndicator color={C.accent} />
              <Text style={[styles.confirmSub, { marginTop: 14 }]}>{label}</Text>
            </View>
          );
        }
        if (phase === 'clash') {
          return (
            <View>
              <Text style={styles.confirmTitle}>You already have a rule for this</Text>
              <Text style={styles.confirmSub}>
                A rule already files “{pattern}” somewhere else — edit it in Rules to change where these go. Nothing has been changed.
              </Text>
              <Pressable testID="add-rule-confirm-close" onPress={() => setSheet(null)} style={[styles.btn, styles.btnPrimary]}>
                <Text style={styles.btnPrimaryText}>Done</Text>
              </Pressable>
            </View>
          );
        }
        if (phase === 'previewFailed') {
          return (
            <View>
              <Text style={styles.confirmTitle}>Couldn't check this rule</Text>
              <Text style={styles.confirmSub}>Nothing has been changed. Try again, or just save the rule for future charges.</Text>
              <Pressable testID="add-rule-confirm-retry" onPress={retry} style={[styles.btn, styles.btnPrimary]}>
                <Text style={styles.btnPrimaryText}>Try again</Text>
              </Pressable>
              <Pressable testID="add-rule-confirm-rule-only" onPress={onRuleOnly} style={[styles.btn, styles.btnGhost]}>
                <Text style={styles.btnGhostText}>Add rule only</Text>
              </Pressable>
            </View>
          );
        }
        if (phase === 'writeFailed') {
          return (
            <View>
              <Text style={styles.confirmTitle}>Couldn't finish</Text>
              <Text style={styles.confirmSub}>
                Some charges may already have been filed. Your lists have been refreshed — open Rules to see whether the rule was added.
              </Text>
              <Pressable testID="add-rule-confirm-close" onPress={() => setSheet(null)} style={[styles.btn, styles.btnPrimary]}>
                <Text style={styles.btnPrimaryText}>Done</Text>
              </Pressable>
            </View>
          );
        }
        if (!report) return null;

        // No stored charge matches yet — nothing to file, so offer only "save the rule" (future
        // charges) plus a way back to fix a mistyped pattern.
        if (report.matched === 0) {
          return (
            <View>
              <View style={[styles.confirmChip, { backgroundColor: tint(chosen.color, 0.16) }]}>
                <Icon name={chosen.icon} size={26} color={chosen.color} />
              </View>
              <Text style={styles.confirmTitle}>No past charges match</Text>
              <Text style={styles.confirmSub}>
                “{pattern}” doesn't match any of your unfiled charges. The rule will still file matching future charges as {chosen.name}.
              </Text>
              <Pressable testID="add-rule-confirm-rule-only" onPress={onRuleOnly} style={[styles.btn, styles.btnPrimary]}>
                <Text style={styles.btnPrimaryText}>Add rule</Text>
              </Pressable>
              <Pressable testID="add-rule-confirm-back" onPress={goBack} style={[styles.btn, styles.btnGhost]}>
                <Text style={styles.btnGhostText}>Back</Text>
              </Pressable>
            </View>
          );
        }

        // The server files at most APPLY_RULES_MAX_WRITES per call, so a big match takes more than one go.
        const capped = report.matched > APPLY_RULES_MAX_WRITES;
        // The inline rule is the only rule in the plan, so its samples live at byRule[0]. Guard the
        // index (an empty byRule is possible) and drop null descriptions.
        const samples = (report.byRule[0]?.samples ?? []).filter((sample): sample is string => !!sample);
        return (
          <View>
            <View style={[styles.confirmChip, { backgroundColor: tint(chosen.color, 0.16) }]}>
              <Icon name={chosen.icon} size={26} color={chosen.color} />
            </View>
            <Text style={styles.confirmTitle}>File past charges too?</Text>
            <Text style={styles.confirmSub}>
              “{pattern}” matches {report.matched} past {chargeNoun(report.matched)} you haven't filed. File them as {chosen.name} now,
              or just save the rule for future charges.
              {capped ? ' Filing them all runs in the background — you can leave and it keeps going.' : ''}
            </Text>
            {samples.length > 0 && (
              <View testID="add-rule-confirm-samples" style={styles.ruleConflict}>
                {samples.map((sample, index) => (
                  <Text key={index} style={styles.applyRulesSample} numberOfLines={1}>{sample}</Text>
                ))}
              </View>
            )}
            {capped ? (
              <>
                <Pressable testID="add-rule-confirm-file-all" onPress={onApplyAll} style={[styles.btn, styles.btnPrimary]}>
                  <Text style={styles.btnPrimaryText}>Add rule + file all history</Text>
                </Pressable>
                <Pressable testID="add-rule-confirm-file" onPress={onCommit} style={[styles.btn, styles.btnGhost]}>
                  <Text style={styles.btnGhostText}>Add rule + file up to {APPLY_RULES_MAX_WRITES}</Text>
                </Pressable>
              </>
            ) : (
              <Pressable testID="add-rule-confirm-file" onPress={onCommit} style={[styles.btn, styles.btnPrimary]}>
                <Text style={styles.btnPrimaryText}>Add rule + file {report.matched} {chargeNoun(report.matched)}</Text>
              </Pressable>
            )}
            <Pressable testID="add-rule-confirm-rule-only" onPress={onRuleOnly} style={[styles.btn, styles.btnGhost]}>
              <Text style={styles.btnGhostText}>Add rule only</Text>
            </Pressable>
            <Pressable testID="add-rule-confirm-back" onPress={goBack} style={[styles.btn, styles.btnGhost]}>
              <Text style={styles.btnGhostText}>Back</Text>
            </Pressable>
          </View>
        );
      }}
    />
  );
}

/** The success toast after "Add rule + file N". A capped run leaves more to go, so it points at
 *  "Apply my rules" to finish the rest (the rule now exists, so that sweep will catch them). */
function addRuleFiledMessage(report: ApplyRulesResult, categoryName: string): string {
  const filed = report.filed.length;
  if (filed === 0) return `Rule added — it files as ${categoryName}.`;
  const base = `Rule added — filed ${filed} past ${chargeNoun(filed)} as ${categoryName}`;
  return report.matched > APPLY_RULES_MAX_WRITES ? `${base}. More to go — use “Apply my rules” to finish.` : `${base}.`;
}

/** Why nothing can be filed, named from the report rather than guessed. Every arm is reachable:
 *  no rule survived the server's checks, the rules that did survive disagree, or they genuinely
 *  match nothing. */
function nothingToFileReason(report: ApplyRulesResult, applicable: number): string {
  const ruleNoun = report.rulesConsidered === 1 ? 'rule' : 'rules';
  if (applicable === 0) return `None of your ${report.rulesConsidered} ${ruleNoun} can be applied — see why below.`;
  if (report.conflicted > 0) return `Your rules disagree about every charge they cover, so none were filed.`;
  return `None of your ${report.rulesConsidered} ${ruleNoun} match your ${report.unfiled} unfiled ${chargeNoun(report.unfiled)}.`;
}

/** What a partial round reports when the sheet was dismissed before it finished. */
function applyRulesRoundMessage(filed: number, stillToGo: number): string {
  if (filed === 0) return `Couldn't file any — ${stillToGo} still to go.`;
  return `Filed ${filed} ${chargeNoun(filed)} — ${stillToGo} still to go.`;
}

/** The one success toast, so a clean run and a finished multi-round run read the same. */
function applyRulesDoneMessage(filed: number): string {
  if (filed === 0) return 'Nothing left for your rules to file.';
  return `Filed ${filed} ${chargeNoun(filed)} with your rules.`;
}

/** Cancel/Close writes nothing — the preview that opened this sheet was a dry run. */
function ApplyRulesCancel({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable testID="apply-rules-cancel" onPress={onPress} style={[styles.btn, styles.btnGhost]}>
      <Text style={styles.btnGhostText}>{label}</Text>
    </Pressable>
  );
}

// The breakdown that makes this a preview rather than a dare: one row per rule with its count and
// a few real descriptions, so a rule matching far more than expected is obvious before the write.
// The server already sorts biggest-first, so the worst offender is always the first thing on screen.
function ApplyRulesDetail({ report, category }: {
  report: ApplyRulesResult;
  category: (id: string | null) => Category | undefined;
}) {
  return (
    <ScrollView style={styles.applyRulesScroll}>
      {/* These counts are per-rule HITS, not a total: a rule's matches are counted before the
          conflict check, so a charge two rules both catch is counted under each and the rows can
          sum to more than the headline. Say so rather than let the numbers look broken. */}
      {report.byRule.length > 0 && (
        <Text style={styles.fieldLabel}>
          What each rule catches{report.conflicted > 0 ? ' (a charge two rules both catch is counted under each)' : ''}
        </Text>
      )}
      {report.byRule.map((rule, index) => (
        <View key={rule.ruleId ?? `rule-${index}`} testID="apply-rules-rule" style={styles.applyRulesRow}>
          <Text style={styles.applyRulesRuleText}>
            "{rule.value ?? '—'}" → {categoryLabel(rule.categoryId, category)} · {rule.count} {chargeNoun(rule.count)}
          </Text>
          {rule.samples.filter((sample) => sample).map((sample, sampleIndex) => (
            <Text key={sampleIndex} style={styles.applyRulesSample} numberOfLines={1}>{sample}</Text>
          ))}
        </View>
      ))}

      {report.conflicted > 0 && (
        <View testID="apply-rules-conflicts" style={styles.ruleConflict}>
          <Text style={styles.ruleConflictText}>
            {report.conflicted} {chargeNoun(report.conflicted)} match two rules that disagree, so they're left alone.
          </Text>
          {report.conflictedSamples.map((conflict, index) => (
            <Text key={index} style={styles.applyRulesSample} numberOfLines={1}>
              {conflict.description ?? '—'} — {conflict.categoryIds.map((id) => categoryLabel(id, category)).join(' vs ')}
            </Text>
          ))}
        </View>
      )}

      {report.skippedRules.length > 0 && (
        <View testID="apply-rules-skipped" style={styles.applyRulesSkipped}>
          <Text style={styles.fieldLabel}>
            {report.skippedRules.length} {report.skippedRules.length === 1 ? 'rule' : 'rules'} skipped
          </Text>
          {/* The reason text is authored server-side and already plain English. Rendered verbatim
              rather than through a client re-wording map, which would drift silently. */}
          {report.skippedRules.map((skipped, index) => (
            <Text key={skipped.id ?? `skipped-${index}`} style={styles.applyRulesSample}>
              "{skipped.value ?? '—'}" — {skipped.reason}
            </Text>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  // toast
  toastWrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center', zIndex: 200 },
  toast: { maxWidth: '88%', backgroundColor: '#26262f', borderWidth: 1, borderColor: 'rgba(255,255,255,.1)', paddingVertical: 11, paddingHorizontal: 16, borderRadius: 14 },
  toastText: { fontFamily: FONT.body, color: C.textBright, fontSize: 13.5, textAlign: 'center' },
  // sheet
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,.55)', justifyContent: 'flex-end', alignItems: 'center' },
  // Wraps the sheet so the spring transform (translateY) doesn't disturb its bottom-anchored,
  // horizontally-centred layout (WHIT-199).
  sheetLift: { width: '100%', alignItems: 'center' },
  // Opt-in for the category picker only (see SheetHost): lets the sheet shrink to the space above the
  // keyboard so a tall inline "New category" form scrolls inside it instead of overflowing off the top.
  // Inert when the content already fits (the plain picker list), so that layout is unchanged.
  sheetShrink: { flexShrink: 1 },
  // WHIT-293: paddingTop trimmed (20 → 12) to offset the taller grab strip above, so the grabber
  // bar stays put visually while its touch target grows up toward the sheet's top edge.
  sheet: { width: '100%', maxWidth: 440, backgroundColor: '#161620', borderTopLeftRadius: 26, borderTopRightRadius: 26, padding: 20, paddingTop: 12, paddingBottom: 34, borderTopWidth: 1, borderColor: 'rgba(255,255,255,.08)' },
  // WHIT-290/WHIT-293: the grabber's drag target — a full-width strip across the top of the sheet
  // so a pull-down anywhere up here dismisses. Enlarged vertically (WHIT-293) so a pull that starts
  // a little off the thin bar still lands on the target instead of missing. The extra paddingTop
  // is absorbed by trimming the sheet's own top padding below, so the bar doesn't visibly shift.
  grabHandle: { alignSelf: 'stretch', alignItems: 'center', paddingTop: 14, paddingBottom: 16 },
  grabber: { width: 38, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,.18)' },
  sheetTitle: { fontFamily: FONT.display, fontSize: 20, fontWeight: '700', color: C.text, letterSpacing: -0.3 },
  sheetMerchant: { fontFamily: FONT.body, fontSize: 14, color: C.textMid, marginTop: 8 },
  // The inline "New category" form: the title/subtitle stay fixed while the form scrolls. flexShrink
  // lets this View (and the ScrollView inside) shrink within the keyboard-bounded sheet so the form
  // never spills off-screen; the paddingTop replaces the old 14px gap under the subtitle.
  createForm: { flexShrink: 1 },
  createScroll: { flexShrink: 1 },
  createScrollContent: { paddingTop: 14 },
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
  // WHIT-560: the async apply-rules progress bar.
  jobProgressTrack: { height: 8, borderRadius: 4, backgroundColor: C.progressTrack, marginTop: 16, overflow: 'hidden' },
  jobProgressFill: { height: 8, borderRadius: 4, backgroundColor: C.accent },
  fieldLabel: { fontFamily: FONT.body, fontSize: 12, fontWeight: '700', color: C.textMid, letterSpacing: 0.3, marginTop: 16, marginBottom: 7 },
  input: { backgroundColor: C.card, borderWidth: 1, borderColor: 'rgba(255,255,255,.08)', borderRadius: 14, paddingVertical: 14, paddingHorizontal: 16, color: '#fff', fontFamily: FONT.body, fontSize: 15 },
  ruleCatWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  ruleCatPill: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 11, borderWidth: 1 },
  ruleCatText: { fontFamily: FONT.body, fontSize: 13, fontWeight: '600' },
  ruleConflict: { marginTop: 16, backgroundColor: tint('#F2C94C', 0.1), borderWidth: 1, borderColor: 'rgba(242,201,76,.4)', borderRadius: 14, padding: 14 },
  ruleConflictText: { fontFamily: FONT.body, fontSize: 13.5, color: C.textBright, lineHeight: 19 },
  cycleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 15, paddingHorizontal: 16, borderRadius: 14, borderWidth: 1 },
  cycleText: { fontFamily: FONT.body, fontSize: 15, fontWeight: '600' },
  cycleSectionLabel: { fontFamily: FONT.body, fontSize: 13, fontWeight: '700', color: C.textMid, marginTop: 20, letterSpacing: 0.2 },
  cycleSectionHint: { fontFamily: FONT.body, fontSize: 12.5, color: C.textDim, lineHeight: 18, marginTop: 4 },

  // apply-rules (WHIT-508) — bounded so a long rule list scrolls inside the sheet, like the picker
  applyRulesBusy: { alignItems: 'center', paddingVertical: 34 },
  applyRulesScroll: { maxHeight: 300, marginTop: 16 },
  applyRulesRow: { paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: C.hairline },
  applyRulesRuleText: { fontFamily: FONT.body, fontSize: 14, fontWeight: '600', color: C.textBright },
  applyRulesSample: { fontFamily: FONT.body, fontSize: 12.5, color: C.textDim, marginTop: 3 },
  applyRulesSkipped: { marginTop: 4 },
  // WHIT-517: "File by shop" — a back link, the shop-row layout (name/samples grow, count + chevron
  // pin right).
  sheetBack: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4, marginBottom: 4 },
  sheetBackText: { fontFamily: FONT.body, fontSize: 14, color: C.textMid },
  fileByShopGroupText: { flex: 1 },
  fileByShopCount: { fontFamily: FONT.body, fontSize: 15, fontWeight: '700', color: C.accentSoft, marginRight: 4 },
});
