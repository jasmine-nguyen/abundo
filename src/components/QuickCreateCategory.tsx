import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { C, FONT } from '../theme';
import { Bucket, Category, eligibleParents } from '../context';
import { CategoryFields } from './CategoryFields';
import { useInFlightGuard } from '../hooks/useInFlightGuard';

// A category draft the caller decides what to do with: the categorise sheet (WHIT-238)
// persists it and files the transaction into it; the category-edit screen (WHIT-237)
// collects it as a pending child. `parent` is null unless a parent was picked/fixed.
export interface CategoryDraft { name: string; bucket: Bucket; icon: string; parent: string | null; }

// One compact "make a category" form, shared by the categorise sheet and the category-edit
// screen's "new sub-category" inline. Presentational: it gathers a draft and hands it to
// `onSubmit` — it does NOT call the store, so each surface persists (or defers) as it needs.
// The field controls themselves live in the shared CategoryFields (WHIT-239); this wrapper
// owns the state, the bucket-change parent-drop, and the submit/cancel actions.
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
  readDraft,
  writeDraft,
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
  // WHIT-283: OPT-IN draft persistence so a half-typed new category survives a Face ID lock.
  // The picker host passes these (backed by the WHIT-277 draft store); the category-edit host
  // passes nothing → `readDraft` is undefined (no restore) and the persist effect no-ops, so this
  // shared component is byte-for-byte unchanged there. Callbacks (not a context hook) keep the
  // component decoupled — quickCreateCategory.screen.test.tsx renders it with NO AppProvider.
  readDraft?: () => Partial<CategoryDraft> | undefined;
  writeDraft?: (draft: CategoryDraft) => void;
}) {
  const draft = readDraft?.();
  const [name, setName] = useState(() => draft?.name ?? '');
  const [bucket, setBucket] = useState<Bucket>(() => draft?.bucket ?? initialBucket);
  const [icon, setIcon] = useState(() => draft?.icon ?? 'coffee');
  const [parent, setParent] = useState<string | null>(() => (draft ? draft.parent ?? null : fixedParent));

  // A picked parent must stay same-bucket: if the bucket changes under it, drop to top-level.
  useEffect(() => {
    if (!parentPicker) return;
    setParent((cur) => (cur !== null && !eligibleParents(categories, null, bucket).some((c) => c.id === cur) ? null : cur));
  }, [bucket, parentPicker, categories]);

  // WHIT-283: persist the draft after each change from the COMMITTED state (an effect, not the
  // field handlers, so no stale closure). No-op when `writeDraft` is omitted (category-edit).
  // Persists the RAW name so the field round-trips exactly across a lock; submit keeps its .trim().
  useEffect(() => {
    writeDraft?.({ name, bucket, icon, parent: parentPicker ? parent : fixedParent });
  }, [name, bucket, icon, parent, parentPicker, fixedParent, writeDraft]);

  // WHIT-241: a synchronous latch so a same-frame double-tap of the submit button can't emit
  // `onSubmit` twice (which, for the create-and-file / add-sub hosts, would create the category
  // twice). Awaiting `onSubmit` holds the latch for the whole host op — the visible `busy` gate
  // below only flips on the next render, a beat too late for two taps in one frame.
  const runSubmit = useInFlightGuard();
  const canSave = name.trim().length > 0 && !busy;
  const submit = () => {
    if (!canSave) return;
    const draft = { name: name.trim(), bucket, icon, parent: parentPicker ? parent : fixedParent };
    runSubmit(() => onSubmit(draft));
  };

  return (
    <View style={styles.wrap}>
      <CategoryFields
        variant="compact"
        name={name}
        onNameChange={setName}
        namePlaceholder="Category name"
        autoFocusName
        bucket={bucket}
        onBucketChange={setBucket}
        lockBucket={lockBucket}
        icon={icon}
        onIconChange={setIcon}
        parent={parent}
        onParentChange={setParent}
        parentPicker={parentPicker}
        categories={categories}
        editId={null}
        noneLabel="None"
      />

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
  actions: { flexDirection: 'row', gap: 10, marginTop: 6 },
  btn: { paddingVertical: 14, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  btnText: { fontFamily: FONT.body, fontSize: 15, fontWeight: '700' },
  btnGhost: { paddingHorizontal: 18, backgroundColor: 'transparent', borderWidth: 1, borderColor: 'rgba(255,255,255,.1)' },
  btnGhostText: { fontFamily: FONT.body, fontSize: 15, fontWeight: '600', color: '#e2e2e8' },
});
