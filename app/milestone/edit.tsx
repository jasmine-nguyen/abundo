import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import * as Crypto from 'expo-crypto';
import { C, FONT } from '../../src/theme';
import { useAppContext } from '../../src/context';
import { useMilestonesQuery, useIsAuthed } from '../../src/queries';
import { Header } from '../../src/components/Header';
import { NativeDateField } from '../../src/components/NativeDateField';
import { useInFlightGuard } from '../../src/hooks/useInFlightGuard';
import { parseAmount, numText } from '../../src/numutil';
import { MILESTONES, milestonesOrderingError, milestoneOutOfOrderRows } from '../../src/milestones';
import type { MilestoneRecord } from '../../src/api';

// The add/edit/delete/reorder milestone editor (WHIT-377). A pushed screen reached from the
// milestone screen's "Edit plan". Reads and writes the ['milestones'] plan via useMilestonesQuery
// + saveMilestones (the same cache the milestone + mortgage screens render). Mirrors the
// app/goal/edit.tsx form conventions (hydrate-once latch, in-flight guard, save-disabled + toast).

// A row while editing: the target balance is kept as raw input text (parsed on save), exactly as
// the goal form keeps its amount, so a mid-edit blank/partial value doesn't corrupt a number.
interface DraftRow {
  id: string;
  label: string;
  balanceText: string;
  targetDate: string | null;
}

export default function MilestoneEdit() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const s = useAppContext(); // saveMilestones writer + showToast

  // Hydration source: the ['milestones'] cache the milestone screen keeps warm. undefined while a
  // cold cache resolves, [] when the user has never saved a plan, or the saved rows.
  const savedQuery = useMilestonesQuery(useIsAuthed());
  const saved = savedQuery.data;

  const [rows, setRows] = useState<DraftRow[]>(() => seedRows(saved));
  const [saving, setSaving] = useState(false);

  // Re-seed ONCE when the query first resolves (cold cache / deep-link), so the editor never shows
  // — or SAVES — the default plan over a real saved one. The `seeded` latch means a LATER
  // background refetch can't clobber what the user is mid-editing (mirrors goal/edit.tsx:53-67).
  const seeded = useRef(saved !== undefined);
  useEffect(() => {
    if (saved === undefined || seeded.current) return;
    seeded.current = true;
    setRows(seedRows(saved));
  }, [saved]);

  // Block save until the plan has actually resolved: while `saved` is undefined (a cold load OR a
  // settled read error with nothing cached) the editor is showing the DEFAULT, and saving now would
  // write it over a real saved plan the user has. Gate on data-absence, not isLoading, so the error
  // case is covered too — mirrors goal/edit.tsx's `editingUnloaded = editing && !existing`. Once the
  // query resolves to [] (new user → the default IS the intended save) or real rows, save unlocks.
  const unloaded = saved === undefined;

  const records = toRecords(rows);
  const outOfOrder = milestoneOutOfOrderRows(records);

  const updateRow = (id: string, patch: Partial<DraftRow>) =>
    setRows((prev) => prev.map((row) => (row.id === id ? { ...row, ...patch } : row)));

  const addRow = () =>
    setRows((prev) => [...prev, { id: Crypto.randomUUID(), label: '', balanceText: '', targetDate: null }]);

  const deleteRow = (id: string) => setRows((prev) => prev.filter((row) => row.id !== id));

  // Swap a row with its neighbour. Out of bounds (first row up / last row down) is a no-op.
  const moveRow = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= rows.length) return;
    setRows((prev) => {
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const runAction = useInFlightGuard();
  const onSave = () => runAction(async () => {
    if (unloaded || saving) return;
    const error = milestonesOrderingError(records);
    if (error) return s.showToast(error);

    setSaving(true);
    try {
      const ok = await s.saveMilestones(records);
      setSaving(false);
      if (ok) router.back();
    } catch (error) {
      setSaving(false); // re-enable on an unexpected throw; re-throw so the guard logs it
      throw error;
    }
  });

  const canDelete = rows.length > 1;

  return (
    <View style={{ flex: 1, paddingTop: insets.top + 6 }}>
      <Header title="Edit plan" />
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: insets.bottom + 40 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
      >
        <Text style={styles.intro}>
          Each step should be a lower balance and a later date than the one above it.
        </Text>

        {rows.map((row, index) => (
          <View key={row.id} style={[styles.rowCard, outOfOrder[index] && styles.rowCardWarn]}>
            <View style={styles.rowHead}>
              <Text style={styles.rowNum}>Step {index + 1}</Text>
              <View style={styles.rowActions}>
                <Pressable
                  testID={`milestone-up-${index}`}
                  onPress={() => moveRow(index, -1)}
                  disabled={index === 0}
                  accessibilityRole="button"
                  accessibilityLabel="Move milestone up"
                  style={[styles.moveBtn, index === 0 && styles.moveDisabled]}
                >
                  <Text style={styles.moveText}>↑</Text>
                </Pressable>
                <Pressable
                  testID={`milestone-down-${index}`}
                  onPress={() => moveRow(index, 1)}
                  disabled={index === rows.length - 1}
                  accessibilityRole="button"
                  accessibilityLabel="Move milestone down"
                  style={[styles.moveBtn, index === rows.length - 1 && styles.moveDisabled]}
                >
                  <Text style={styles.moveText}>↓</Text>
                </Pressable>
                {canDelete && (
                  <Pressable
                    testID={`milestone-delete-${index}`}
                    onPress={() => deleteRow(row.id)}
                    accessibilityRole="button"
                    accessibilityLabel="Delete milestone"
                    style={styles.moveBtn}
                  >
                    <Text style={[styles.moveText, { color: C.bad }]}>✕</Text>
                  </Pressable>
                )}
              </View>
            </View>

            <Text style={styles.label}>NAME</Text>
            <TextInput
              testID={`milestone-label-${index}`}
              style={styles.input}
              value={row.label}
              onChangeText={(label) => updateRow(row.id, { label })}
              placeholder="e.g. Halfway"
              placeholderTextColor={C.placeholder}
            />

            <Text style={styles.label}>TARGET BALANCE</Text>
            <View style={styles.inputRow}>
              <Text style={styles.affix}>$</Text>
              <TextInput
                testID={`milestone-balance-${index}`}
                style={styles.rowInput}
                value={row.balanceText}
                onChangeText={(balanceText) => updateRow(row.id, { balanceText })}
                placeholder="e.g. 295000"
                placeholderTextColor={C.placeholder}
                keyboardType="decimal-pad"
                inputMode="decimal"
              />
            </View>

            <Text style={styles.label}>TARGET DATE</Text>
            <NativeDateField
              value={row.targetDate}
              onChange={(iso) => updateRow(row.id, { targetDate: iso })}
              placeholder="Pick a date"
            />

            {outOfOrder[index] && (
              <Text style={styles.warn} accessibilityLiveRegion="polite">
                This step is out of order — it needs a lower balance and a later date than the step above.
              </Text>
            )}
          </View>
        ))}

        <Pressable testID="milestone-add" onPress={addRow} style={styles.addBtn} accessibilityRole="button">
          <Text style={styles.addText}>+ Add milestone</Text>
        </Pressable>

        <Pressable
          testID="milestone-save"
          onPress={onSave}
          disabled={saving || unloaded}
          style={[styles.save, (saving || unloaded) && { opacity: 0.6 }]}
        >
          <Text style={styles.saveText}>{saving ? 'Saving…' : 'Save plan'}</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

// The rows the editor opens with: the user's saved plan, or the built-in default (with client ids
// minted) when they've never saved one. A cold cache (undefined) also starts from the default
// until the re-seed effect swaps the real plan in.
function seedRows(saved: MilestoneRecord[] | undefined): DraftRow[] {
  if (saved && saved.length > 0) {
    return saved.map((m) => ({ id: m.id, label: m.label, balanceText: numText(m.targetBalance), targetDate: m.targetDate }));
  }
  return MILESTONES.map((m) => ({
    id: Crypto.randomUUID(),
    label: m.label,
    balanceText: numText(m.targetBalance),
    targetDate: m.targetDate,
  }));
}

// Draft rows -> the MilestoneRecord list the guard checks and saveMilestones sends. An empty or
// partial balance parses to NaN and an unset date to '' — both are caught by the guard, not here.
function toRecords(rows: DraftRow[]): MilestoneRecord[] {
  return rows.map((row) => ({
    id: row.id,
    label: row.label.trim(),
    targetBalance: parseAmount(row.balanceText),
    targetDate: row.targetDate ?? '',
  }));
}

const styles = StyleSheet.create({
  intro: { fontFamily: FONT.body, fontSize: 13, color: C.textMid, marginTop: 12, marginBottom: 6, marginHorizontal: 2, lineHeight: 18 },

  rowCard: { backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 16, padding: 14, marginTop: 12 },
  rowCardWarn: { borderColor: 'rgba(255,183,77,.5)' },
  rowHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowNum: { fontFamily: FONT.body, fontSize: 13, fontWeight: '700', color: C.textMid, letterSpacing: 0.3 },
  rowActions: { flexDirection: 'row', gap: 6 },
  moveBtn: { width: 34, height: 34, borderRadius: 10, borderWidth: 1, borderColor: C.hairline, alignItems: 'center', justifyContent: 'center' },
  moveDisabled: { opacity: 0.35 },
  moveText: { fontFamily: FONT.body, fontSize: 16, fontWeight: '700', color: C.textMid },

  label: { fontFamily: FONT.body, fontSize: 12, fontWeight: '700', color: C.textMid, letterSpacing: 0.3, marginTop: 14, marginBottom: 8, marginHorizontal: 2 },
  input: { fontFamily: FONT.body, fontSize: 16, color: C.text, backgroundColor: C.bg, borderWidth: 1, borderColor: C.hairline, borderRadius: 14, paddingHorizontal: 14, height: 50 },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: C.bg, borderWidth: 1, borderColor: C.hairline, borderRadius: 14, paddingHorizontal: 14, height: 50 },
  rowInput: { flex: 1, fontFamily: FONT.body, fontSize: 16, color: C.text, height: '100%', textAlignVertical: 'center' },
  affix: { fontFamily: FONT.body, fontSize: 16, fontWeight: '600', color: C.textDim },
  warn: { fontFamily: FONT.body, fontSize: 12, color: C.warn, marginTop: 10, lineHeight: 16 },

  addBtn: { marginTop: 14, paddingVertical: 14, borderRadius: 14, borderWidth: 1, borderColor: C.hairline, borderStyle: 'dashed', alignItems: 'center' },
  addText: { fontFamily: FONT.body, fontSize: 14, fontWeight: '700', color: C.accent },

  save: { marginTop: 20, paddingVertical: 16, borderRadius: 15, backgroundColor: C.accent, alignItems: 'center' },
  saveText: { fontFamily: FONT.body, fontSize: 16, fontWeight: '700', color: C.accentInk },
});
