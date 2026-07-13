import React, { useState, useEffect } from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, FONT, tint } from '../../src/theme';
import { Icon } from '../../src/icons';
import { useAppContext, Bucket, Category, eligibleParents, eligibleChildren, categoryDepth, MAX_CATEGORY_DEPTH } from '../../src/context';
import { getStatus } from '../../src/auth';
import { useCategories } from '../../src/queries';
import { Header } from '../../src/components/Header';
import { CategoryFields } from '../../src/components/CategoryFields';
import { QuickCreateCategory } from '../../src/components/QuickCreateCategory';
import { useInFlightGuard } from '../../src/hooks/useInFlightGuard';

export default function CategoryEdit() {
  const s = useAppContext(); // saveCategory / deleteCategory writers stay on the store
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { categoryId } = useLocalSearchParams<{ categoryId?: string }>();
  // WHIT-203: the prefill lookup reads the cached taxonomy.
  const { categories, category } = useCategories();
  const existing = categoryId ? category(categoryId) : undefined;

  const [name, setName] = useState(existing?.name ?? '');
  const [bucket, setBucket] = useState<Bucket>(existing?.bucket ?? 'Lifestyle');
  const [icon, setIcon] = useState(existing?.icon ?? 'coffee');
  // WHIT-221: the category this one rolls up into (null = top-level).
  const [parent, setParent] = useState<string | null>(existing?.parent ?? null);
  // WHIT-203: the useState seeds run once, but on the query layer `existing` may resolve a
  // beat AFTER mount (cold cache / deep-link). Re-seed when it arrives so an edit never
  // shows — or SAVES — a blank "create" form over a real category.
  useEffect(() => {
    if (existing) { setName(existing.name); setBucket(existing.bucket); setIcon(existing.icon); setParent(existing.parent ?? null); }
  }, [existing]);

  // A sub must share its parent's bucket (server rule), never be its own ancestor, and never
  // nest under itself — the shared helper enforces all three. The picker itself lives in
  // CategoryFields, which recomputes the same eligible set from the in-form bucket (WHIT-239).
  // Keep the held parent valid: if it ever becomes ineligible (the bucket changed, or a
  // legacy/cross-bucket link loaded), drop it to top-level. Without this a stale parent
  // could be invisible in the picker yet silently re-saved. Runs after the re-seed above.
  useEffect(() => {
    setParent((cur) => (cur !== null && !eligibleParents(categories, categoryId ?? null, bucket).some((c) => c.id === cur) ? null : cur));
  }, [bucket, categories, categoryId]);

  // WHIT-237: build the family from the parent's side. `attachIds` = existing categories to
  // re-parent under this one; `newChildren` = brand-new subs to create under it on save.
  const [attachIds, setAttachIds] = useState<string[]>([]);
  const [newChildren, setNewChildren] = useState<{ name: string; icon: string }[]>([]);
  const [addingChild, setAddingChild] = useState(false);
  // Categories that MAY be nested under this one (same bucket, no cycle, within the 5-level
  // cap), minus the ones already parented here (shown separately). Live-refilters on bucket.
  const currentChildren = categoryId ? categories.filter((c) => c.parent === categoryId) : [];
  const attachCandidates = eligibleChildren(categories, categoryId ?? null, parent, bucket)
    // Existing children are shown separately (as "Already nested") — drop them from the attach
    // list. A NEW category (no id) has no children yet, so nothing is dropped here.
    .filter((c) => !categoryId || c.parent !== categoryId);
  // This category's own level, so a NEW leaf sub (level self+1) can't be offered past the cap.
  // One shared helper with eligibleChildren so the depth rule can't drift (WHIT-237).
  const canAddNewChild = categoryDepth(categories, parent) < MAX_CATEGORY_DEPTH;
  // Drop any attach pick that stops being eligible when the bucket/parent changes (mirrors the
  // parent picker's live re-filter). New children inherit the parent's bucket, so they stay.
  useEffect(() => {
    const okIds = new Set(eligibleChildren(categories, categoryId ?? null, parent, bucket).map((c) => c.id));
    // Return the SAME array when nothing is dropped — `filter` always allocates a fresh array,
    // and setting a new reference here would re-render → re-run this effect → loop forever if
    // `categories` identity is unstable (WHIT-244). Only change state when picks actually go.
    setAttachIds((prev) => {
      const next = prev.filter((id) => okIds.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [bucket, parent, categories, categoryId]);

  const color = existing?.color ?? C.accent;
  const [submitting, setSubmitting] = useState(false);
  // Block save while editing a category whose taxonomy hasn't loaded yet — otherwise a save
  // would write the default bucket/icon back over the real ones.
  const editingUnloaded = !!categoryId && !existing;
  const canSave = name.trim().length > 0 && !submitting && !editingUnloaded;

  // WHIT-241: guard the whole save against a same-frame double-tap (the visible `submitting`
  // flag only blocks from the NEXT render, so two taps in one frame would both create/save).
  const runSave = useInFlightGuard();
  const save = () => runSave(async () => {
    if (!canSave) return;
    setSubmitting(true);
    // WHIT-249: re-enable the button if a writer throws UNEXPECTEDLY (the known-failure branches
    // already reset + return; success navigates away). Re-throw so the guard still logs it.
    try {
      // 1) Save the category itself. A NEW parent must persist first so its children can point
      // at its server-assigned id (WHIT-237).
      let parentId = categoryId ?? null;
      // WHIT-240: the parent + every child write run SILENT so the per-op toasts don't stack;
      // this screen fires one summary toast at the end. On a parent failure the writer no longer
      // toasts, so own that message here before bailing.
      if (categoryId) {
        const ok = await s.saveCategory(categoryId, { name, bucket, icon, parent }, { silent: true });
        // WHIT-271: a mid-save sign-out makes the writer return false; bail silently rather than
        // toasting the generic failure / navigating into the next session.
        if (getStatus() === 'anon') { setSubmitting(false); return; }
        if (!ok) { s.showToast('Could not save category. Please try again.'); setSubmitting(false); return; }
      } else {
        const created = await s.createCategoryInline({ name, bucket, icon, parent }, { silent: true });
        if (getStatus() === 'anon') { setSubmitting(false); return; }
        if (!created) { s.showToast('Could not save category. Please try again.'); setSubmitting(false); return; }
        parentId = created.id;
      }
      // 2) Attach the picked existing children + create the new inline ones under this parent.
      // Re-parenting resends the child's OWN name/bucket/icon (the PATCH replaces them); new subs
      // inherit this category's bucket. Run them together; a failure drops only that child.
      const byId = new Map(categories.map((c) => [c.id, c]));
      const ops: Promise<boolean | Category | null>[] = [];
      for (const id of attachIds) {
        const child = byId.get(id);
        if (child) ops.push(s.saveCategory(id, { name: child.name, bucket: child.bucket, icon: child.icon, parent: parentId }, { silent: true }));
      }
      for (const nc of newChildren) {
        ops.push(s.createCategoryInline({ name: nc.name, bucket, icon: nc.icon, parent: parentId }, { silent: true }));
      }
      const results = ops.length ? await Promise.allSettled(ops) : [];
      // WHIT-271: sign-out during the child writes → don't fire the summary toast + router.back().
      if (getStatus() === 'anon') { setSubmitting(false); return; }
      const failed = results.filter((r) => r.status === 'rejected' || r.value === false || r.value === null).length;
      // WHIT-240: exactly ONE summary toast. Lead with created/updated (matching the writers' own
      // copy) so the message reads consistently, then report the sub-category outcome. Option A
      // (agreed WHIT-237): a flaky child never rolls back a good parent — it's reported, not undone.
      const verb = categoryId ? 'updated' : 'created';
      const subCount = (n: number) => `${n} sub-categor${n === 1 ? 'y' : 'ies'}`;
      if (failed > 0) {
        s.showToast(`Category ${verb}, but ${subCount(failed)} couldn't be attached — add ${failed === 1 ? 'it' : 'them'} from its page.`);
      } else if (ops.length > 0) {
        s.showToast(`Category ${verb}, with ${subCount(ops.length)}.`);
      } else {
        s.showToast(`Category ${verb}.`);
      }
      router.back();
    } catch (error) {
      setSubmitting(false);
      throw error;
    }
  });
  // WHIT-241: same-frame double-tap guard on Delete (a separate latch from save — each button
  // guards only its own double-tap).
  const runRemove = useInFlightGuard();
  const remove = () => runRemove(async () => {
    if (!categoryId || submitting) return;
    setSubmitting(true);
    try {
      const ok = await s.deleteCategory(categoryId);
      if (ok) router.back();
      else setSubmitting(false);
    } catch (error) {
      setSubmitting(false); // WHIT-249: re-enable on an unexpected throw; re-throw so the guard logs it
      throw error;
    }
  });

  return (
    <View style={{ flex: 1, paddingTop: insets.top + 6 }}>
      <Header title={categoryId ? 'Edit category' : 'New category'} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: insets.bottom + 30 }} showsVerticalScrollIndicator={false}>
        <View style={styles.preview}>
          <View style={[styles.previewChip, { backgroundColor: tint(color, 0.15) }]}><Icon name={icon} size={34} color={color} /></View>
        </View>

        <CategoryFields
          variant="screen"
          name={name}
          onNameChange={setName}
          namePlaceholder="e.g. Coffee runs"
          bucket={bucket}
          onBucketChange={setBucket}
          icon={icon}
          onIconChange={setIcon}
          parent={parent}
          onParentChange={setParent}
          parentPicker
          categories={categories}
          editId={categoryId ?? null}
          noneLabel="None (top-level)"
        />

        {/* WHIT-237: nest existing categories under this one, and/or create new subs inline. */}
        {(attachCandidates.length > 0 || canAddNewChild || currentChildren.length > 0 || newChildren.length > 0) && (
          <>
            <Text style={styles.fieldLabel}>SUB-CATEGORIES (OPTIONAL)</Text>
            {currentChildren.length > 0 && (
              <Text style={styles.subHint}>Already nested: {currentChildren.map((c) => c.name).join(', ')}</Text>
            )}
            {attachCandidates.length > 0 && (
              <View style={styles.bucketRow}>
                {attachCandidates.map((c) => {
                  const sel = attachIds.includes(c.id);
                  return (
                    <Pressable
                      key={c.id}
                      testID={`attachChild-${c.id}`}
                      onPress={() => setAttachIds((prev) => (sel ? prev.filter((x) => x !== c.id) : [...prev, c.id]))}
                      style={[styles.bucketBtn, { borderColor: sel ? c.color : 'rgba(255,255,255,.07)', backgroundColor: sel ? tint(c.color, 0.14) : C.card }]}
                    >
                      <Text style={[styles.bucketText, { color: sel ? c.color : C.textMid }]} numberOfLines={1}>{sel ? '✓ ' : ''}{c.name}</Text>
                    </Pressable>
                  );
                })}
              </View>
            )}
            {newChildren.length > 0 && (
              <View style={[styles.bucketRow, { marginTop: 8 }]}>
                {newChildren.map((nc, i) => (
                  <Pressable
                    key={`new-${i}`}
                    onPress={() => setNewChildren((prev) => prev.filter((_, j) => j !== i))}
                    style={[styles.bucketBtn, { borderColor: C.accent, backgroundColor: 'rgba(124,140,255,.14)' }]}
                  >
                    <Text style={[styles.bucketText, { color: C.accentSofter }]} numberOfLines={1}>{nc.name}  ✕</Text>
                  </Pressable>
                ))}
              </View>
            )}
            {addingChild ? (
              <View style={{ marginTop: 10 }}>
                <QuickCreateCategory
                  initialBucket={bucket}
                  lockBucket
                  submitLabel="Add sub-category"
                  onSubmit={(d) => { setNewChildren((prev) => [...prev, { name: d.name, icon: d.icon }]); setAddingChild(false); }}
                  onCancel={() => setAddingChild(false)}
                />
              </View>
            ) : (
              canAddNewChild && (
                <Pressable onPress={() => setAddingChild(true)} style={styles.addChildBtn}>
                  <Text style={styles.addChildText}>＋ New sub-category</Text>
                </Pressable>
              )
            )}
          </>
        )}

        {categoryId && (
          <Pressable onPress={remove} style={styles.deleteBtn}>
            <Text style={styles.deleteText}>Delete category</Text>
          </Pressable>
        )}
        <Pressable onPress={save} style={[styles.saveBtn, { backgroundColor: canSave ? C.accent : 'rgba(124,140,255,.25)' }]}>
          <Text style={[styles.saveText, { color: canSave ? C.accentInk : '#6a6a90' }]}>Save category</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  preview: { alignItems: 'center', paddingVertical: 14 },
  previewChip: { width: 72, height: 72, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  fieldLabel: { fontFamily: FONT.body, fontSize: 12, fontWeight: '700', color: C.textMid, letterSpacing: 0.3, marginTop: 18, marginBottom: 8, marginHorizontal: 2 },
  bucketRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  bucketBtn: { flexGrow: 1, minWidth: '47%', alignItems: 'center', paddingVertical: 13, borderRadius: 13, borderWidth: 1 },
  bucketText: { fontFamily: FONT.body, fontSize: 14, fontWeight: '600' },
  subHint: { fontFamily: FONT.body, fontSize: 13, color: C.textDim, marginBottom: 8, marginHorizontal: 2 },
  addChildBtn: { marginTop: 10, paddingVertical: 13, borderRadius: 13, borderWidth: 1, borderStyle: 'dashed', borderColor: 'rgba(124,140,255,.4)', alignItems: 'center' },
  addChildText: { fontFamily: FONT.body, fontSize: 14, fontWeight: '600', color: C.accentSofter },
  deleteBtn: { marginTop: 24, paddingVertical: 15, borderRadius: 15, borderWidth: 1, borderColor: 'rgba(255,107,107,.3)', backgroundColor: 'rgba(255,107,107,.08)', alignItems: 'center' },
  deleteText: { fontFamily: FONT.body, fontSize: 15, fontWeight: '600', color: C.bad },
  saveBtn: { marginTop: 12, paddingVertical: 16, borderRadius: 15, alignItems: 'center' },
  saveText: { fontFamily: FONT.body, fontSize: 16, fontWeight: '700' },
});
