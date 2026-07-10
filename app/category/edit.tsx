import React, { useState, useEffect } from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView, TextInput } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, FONT, tint } from '../../src/theme';
import { Icon } from '../../src/icons';
import { useAppContext, BUCKETS, BUCKET_COLOR, Bucket, eligibleParents } from '../../src/context';
import { useCategories } from '../../src/queries';
import { ICON_KEYS } from '../../src/icons';
import { Header } from '../../src/components/Header';

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

  // A sub must share its parent's bucket (server rule), never be its own ancestor, and
  // never nest under itself — the shared helper enforces all three. Recomputed from the
  // in-form bucket so switching bucket re-filters the options live.
  const parentOptions = eligibleParents(categories, categoryId ?? null, bucket);
  // Keep the held parent valid: if it ever becomes ineligible (the bucket changed, or a
  // legacy/cross-bucket link loaded), drop it to top-level. Without this a stale parent
  // could be invisible in the picker yet silently re-saved. Runs after the re-seed above.
  useEffect(() => {
    setParent((cur) => (cur !== null && !eligibleParents(categories, categoryId ?? null, bucket).some((c) => c.id === cur) ? null : cur));
  }, [bucket, categories, categoryId]);

  const color = existing?.color ?? C.accent;
  const [submitting, setSubmitting] = useState(false);
  // Block save while editing a category whose taxonomy hasn't loaded yet — otherwise a save
  // would write the default bucket/icon back over the real ones.
  const editingUnloaded = !!categoryId && !existing;
  const canSave = name.trim().length > 0 && !submitting && !editingUnloaded;

  const save = async () => {
    if (!canSave) return;
    setSubmitting(true);
    const ok = await s.saveCategory(categoryId ?? null, { name, bucket, icon, parent });
    if (ok) router.back();
    else setSubmitting(false); // stay on the screen so the user can retry
  };
  const remove = async () => {
    if (!categoryId || submitting) return;
    setSubmitting(true);
    const ok = await s.deleteCategory(categoryId);
    if (ok) router.back();
    else setSubmitting(false);
  };

  return (
    <View style={{ flex: 1, paddingTop: insets.top + 6 }}>
      <Header title={categoryId ? 'Edit category' : 'New category'} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: insets.bottom + 30 }} showsVerticalScrollIndicator={false}>
        <View style={styles.preview}>
          <View style={[styles.previewChip, { backgroundColor: tint(color, 0.15) }]}><Icon name={icon} size={34} color={color} /></View>
        </View>

        <Text style={styles.fieldLabel}>CATEGORY NAME</Text>
        <TextInput value={name} onChangeText={setName} placeholder="e.g. Coffee runs" placeholderTextColor={C.placeholder} style={styles.input} />

        <Text style={styles.fieldLabel}>BUCKET</Text>
        <View style={styles.bucketRow}>
          {BUCKETS.map((bk) => {
            const sel = bucket === bk;
            const col = BUCKET_COLOR[bk];
            return (
              <Pressable key={bk} onPress={() => setBucket(bk)} style={[styles.bucketBtn, { borderColor: sel ? col : 'rgba(255,255,255,.07)', backgroundColor: sel ? tint(col, 0.14) : C.card }]}>
                <Text style={[styles.bucketText, { color: sel ? col : C.textMid }]}>{bk}</Text>
              </Pressable>
            );
          })}
        </View>

        {parentOptions.length > 0 && (
          <>
            <Text style={styles.fieldLabel}>PARENT (OPTIONAL)</Text>
            <View style={styles.bucketRow}>
              <Pressable onPress={() => setParent(null)} style={[styles.bucketBtn, { borderColor: parent === null ? C.accent : 'rgba(255,255,255,.07)', backgroundColor: parent === null ? 'rgba(124,140,255,.14)' : C.card }]}>
                <Text style={[styles.bucketText, { color: parent === null ? C.accentSofter : C.textMid }]}>None (top-level)</Text>
              </Pressable>
              {parentOptions.map((p) => {
                const sel = parent === p.id;
                return (
                  <Pressable key={p.id} onPress={() => setParent(p.id)} style={[styles.bucketBtn, { borderColor: sel ? p.color : 'rgba(255,255,255,.07)', backgroundColor: sel ? tint(p.color, 0.14) : C.card }]}>
                    <Text style={[styles.bucketText, { color: sel ? p.color : C.textMid }]} numberOfLines={1}>{p.name}</Text>
                  </Pressable>
                );
              })}
            </View>
          </>
        )}

        <Text style={styles.fieldLabel}>ICON</Text>
        <View style={styles.iconGrid}>
          {ICON_KEYS.map((k) => {
            const sel = icon === k;
            return (
              <Pressable key={k} onPress={() => setIcon(k)} style={[styles.iconBtn, { borderColor: sel ? C.accent : 'rgba(255,255,255,.07)', backgroundColor: sel ? 'rgba(124,140,255,.14)' : C.card }]}>
                <Icon name={k} size={22} color={sel ? C.accentSofter : C.textMid} />
              </Pressable>
            );
          })}
        </View>

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
  input: { backgroundColor: C.card, borderWidth: 1, borderColor: 'rgba(255,255,255,.08)', borderRadius: 14, paddingVertical: 15, paddingHorizontal: 16, color: '#fff', fontFamily: FONT.body, fontSize: 15 },
  bucketRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  bucketBtn: { flexGrow: 1, minWidth: '47%', alignItems: 'center', paddingVertical: 13, borderRadius: 13, borderWidth: 1 },
  bucketText: { fontFamily: FONT.body, fontSize: 14, fontWeight: '600' },
  iconGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  iconBtn: { width: 52, height: 52, borderRadius: 13, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  deleteBtn: { marginTop: 24, paddingVertical: 15, borderRadius: 15, borderWidth: 1, borderColor: 'rgba(255,107,107,.3)', backgroundColor: 'rgba(255,107,107,.08)', alignItems: 'center' },
  deleteText: { fontFamily: FONT.body, fontSize: 15, fontWeight: '600', color: C.bad },
  saveBtn: { marginTop: 12, paddingVertical: 16, borderRadius: 15, alignItems: 'center' },
  saveText: { fontFamily: FONT.body, fontSize: 16, fontWeight: '700' },
});
