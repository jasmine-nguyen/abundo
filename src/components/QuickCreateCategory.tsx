import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, TextInput, ScrollView } from 'react-native';
import { C, FONT, tint } from '../theme';
import { Icon, ICON_KEYS } from '../icons';
import { BUCKETS, BUCKET_COLOR, Bucket, Category, eligibleParents } from '../context';

// A category draft the caller decides what to do with: the categorise sheet (WHIT-238)
// persists it and files the transaction into it; the category-edit screen (WHIT-237)
// collects it as a pending child. `parent` is null unless a parent was picked/fixed.
export interface CategoryDraft { name: string; bucket: Bucket; icon: string; parent: string | null; }

// One compact "make a category" form, shared by the categorise sheet and the category-edit
// screen's "new sub-category" inline. Presentational: it gathers a draft and hands it to
// `onSubmit` — it does NOT call the store, so each surface persists (or defers) as it needs.
//
// - `lockBucket`     hide the bucket picker (a new sub inherits its parent's bucket).
// - `parentPicker`   show a same-bucket parent picker (the sheet lets you nest the new one).
// - `fixedParent`    the parent to stamp on the draft when there's no picker (a new sub).
export function QuickCreateCategory({
  initialBucket,
  lockBucket = false,
  parentPicker = false,
  fixedParent = null,
  categories = [],
  submitLabel,
  onSubmit,
  onCancel,
  busy = false,
}: {
  initialBucket: Bucket;
  lockBucket?: boolean;
  parentPicker?: boolean;
  fixedParent?: string | null;
  categories?: Category[];
  submitLabel: string;
  onSubmit: (draft: CategoryDraft) => void;
  onCancel?: () => void;
  busy?: boolean;
}) {
  const [name, setName] = useState('');
  const [bucket, setBucket] = useState<Bucket>(initialBucket);
  const [icon, setIcon] = useState('coffee');
  const [parent, setParent] = useState<string | null>(fixedParent);

  const parentOptions = parentPicker ? eligibleParents(categories, null, bucket) : [];
  // A picked parent must stay same-bucket: if the bucket changes under it, drop to top-level.
  useEffect(() => {
    if (!parentPicker) return;
    setParent((cur) => (cur !== null && !eligibleParents(categories, null, bucket).some((c) => c.id === cur) ? null : cur));
  }, [bucket, parentPicker, categories]);

  const canSave = name.trim().length > 0 && !busy;
  const submit = () => {
    if (!canSave) return;
    onSubmit({ name: name.trim(), bucket, icon, parent: parentPicker ? parent : fixedParent });
  };

  return (
    <View style={styles.wrap}>
      <TextInput
        value={name}
        onChangeText={setName}
        placeholder="Category name"
        placeholderTextColor={C.placeholder}
        style={styles.input}
        autoFocus
      />

      {!lockBucket && (
        <View style={styles.row}>
          {BUCKETS.map((bk) => {
            const sel = bucket === bk;
            const col = BUCKET_COLOR[bk];
            return (
              <Pressable
                key={bk}
                onPress={() => setBucket(bk)}
                style={[styles.chip, { borderColor: sel ? col : 'rgba(255,255,255,.07)', backgroundColor: sel ? tint(col, 0.14) : C.cardAlt }]}
              >
                <Text style={[styles.chipText, { color: sel ? col : C.textMid }]}>{bk}</Text>
              </Pressable>
            );
          })}
        </View>
      )}

      {parentPicker && parentOptions.length > 0 && (
        <>
          <Text style={styles.label}>PARENT (OPTIONAL)</Text>
          <View style={styles.row}>
            <Pressable
              onPress={() => setParent(null)}
              style={[styles.chip, { borderColor: parent === null ? C.accent : 'rgba(255,255,255,.07)', backgroundColor: parent === null ? 'rgba(124,140,255,.14)' : C.cardAlt }]}
            >
              <Text style={[styles.chipText, { color: parent === null ? C.accentSofter : C.textMid }]}>None</Text>
            </Pressable>
            {parentOptions.map((p) => {
              const sel = parent === p.id;
              return (
                <Pressable
                  key={p.id}
                  onPress={() => setParent(p.id)}
                  style={[styles.chip, { borderColor: sel ? p.color : 'rgba(255,255,255,.07)', backgroundColor: sel ? tint(p.color, 0.14) : C.cardAlt }]}
                >
                  <Text style={[styles.chipText, { color: sel ? p.color : C.textMid }]} numberOfLines={1}>{p.name}</Text>
                </Pressable>
              );
            })}
          </View>
        </>
      )}

      <Text style={styles.label}>ICON</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.iconRow}>
        {ICON_KEYS.map((k) => {
          const sel = icon === k;
          return (
            <Pressable
              key={k}
              onPress={() => setIcon(k)}
              style={[styles.iconBtn, { borderColor: sel ? C.accent : 'rgba(255,255,255,.07)', backgroundColor: sel ? 'rgba(124,140,255,.14)' : C.cardAlt }]}
            >
              <Icon name={k} size={20} color={sel ? C.accentSofter : C.textMid} />
            </Pressable>
          );
        })}
      </ScrollView>

      <View style={styles.actions}>
        {onCancel && (
          <Pressable onPress={onCancel} style={[styles.btn, styles.btnGhost]}>
            <Text style={styles.btnGhostText}>Cancel</Text>
          </Pressable>
        )}
        <Pressable onPress={submit} style={[styles.btn, { flex: 1, backgroundColor: canSave ? C.accent : 'rgba(124,140,255,.25)' }]}>
          <Text style={[styles.btnText, { color: canSave ? C.accentInk : '#6a6a90' }]}>{submitLabel}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 10 },
  input: { backgroundColor: C.card, borderWidth: 1, borderColor: 'rgba(255,255,255,.08)', borderRadius: 14, paddingVertical: 13, paddingHorizontal: 16, color: '#fff', fontFamily: FONT.body, fontSize: 15 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { flexGrow: 1, minWidth: '47%', alignItems: 'center', paddingVertical: 11, borderRadius: 12, borderWidth: 1 },
  chipText: { fontFamily: FONT.body, fontSize: 13.5, fontWeight: '600' },
  label: { fontFamily: FONT.body, fontSize: 12, fontWeight: '700', color: C.textMid, letterSpacing: 0.3, marginTop: 4, marginBottom: 2 },
  iconRow: { gap: 8, paddingVertical: 2, paddingRight: 8 },
  iconBtn: { width: 46, height: 46, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  actions: { flexDirection: 'row', gap: 10, marginTop: 6 },
  btn: { paddingVertical: 14, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  btnText: { fontFamily: FONT.body, fontSize: 15, fontWeight: '700' },
  btnGhost: { paddingHorizontal: 18, backgroundColor: 'transparent', borderWidth: 1, borderColor: 'rgba(255,255,255,.1)' },
  btnGhostText: { fontFamily: FONT.body, fontSize: 15, fontWeight: '600', color: '#e2e2e8' },
});
